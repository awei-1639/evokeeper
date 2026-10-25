/**
 * 鲁棒性测试（W8 前置）—— 边界输入 / 恶意 payload / 并发竞态 / 损坏数据
 *
 * 与既有测试的分工：inbox.test.ts / agent.test.ts 锁"正常行为约束"，
 * 本文件专打"喂垃圾不许崩"：恶意 webhook payload 形变、HTTP 层滥用、
 * 并发幂等竞态、崩溃半行的 JSONL、extractJson 对抗输入。
 * 全部离线（无网络、无 LLM Key），毫秒级跑完。
 */
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request as httpRequest, type Server } from "node:http";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { extractJson } from "@evokeeper/llm";
import { MemoryInboxStore, parseIssueEvent } from "./inbox";
import { JsonlTraceStore } from "./trace-store";
import { createWebhookServer } from "./webhook-server";

// ---------- parseIssueEvent：恶意 payload 形变 ----------

describe("parseIssueEvent 恶意 payload", () => {
  const base = { action: "opened", repository: { full_name: "a/b" } };

  it("issue.number 各种畸形：浮点/负数/字符串数字/Infinity → 拒绝（null）", () => {
    for (const bad of [3.7, -1, "42", Number.POSITIVE_INFINITY, null, {}]) {
      const p = { ...base, issue: { number: bad, title: "t", body: "b" } };
      expect(parseIssueEvent("issues", p)).toBeNull();
    }
  });

  it("title/body 非字符串 → 按空串处理不崩", () => {
    const p = { ...base, issue: { number: 1, title: 123, body: null } };
    const ev = parseIssueEvent("issues", p);
    expect(ev).not.toBeNull();
    expect(ev?.title).toBe("");
    expect(ev?.body).toBe("");
  });

  it("labels 混入非对象/无 name/数字 → 过滤不崩", () => {
    const p = {
      ...base,
      issue: { number: 1, title: "t", body: "b", labels: [{ name: "bug" }, 7, null, { nope: 1 }, { name: 42 }] },
    };
    const ev = parseIssueEvent("issues", p);
    expect(ev?.rawLabels).toEqual(["bug"]);
  });

  it("__proto__ 键不造成原型污染", () => {
    const p = JSON.parse(
      JSON.stringify({ ...base, issue: { number: 1, title: "t", body: "b" } }).replace(
        '"t"',
        '"t", "__proto__": {"polluted": true}'
      )
    );
    const ev = parseIssueEvent("issues", p);
    expect(ev).not.toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((parseIssueEvent("issues", p) as unknown as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("payload 为数组/字符串/数字/null → null 不抛异常", () => {
    for (const junk of [[], "str", 42, null, true]) {
      expect(parseIssueEvent("issues", junk)).toBeNull();
    }
  });

  it("issue_comment 缺 comment / user → 安全降级 author=unknown", () => {
    const ev = parseIssueEvent("issue_comment", {
      action: "created",
      issue: { number: 1, title: "t", body: "b" },
      repository: { full_name: "a/b" },
      comment: { body: "怎么配置？" },
    });
    expect(ev?.comments?.[0]?.author).toBe("unknown");
  });
});

// ---------- MemoryInboxStore：并发幂等竞态 ----------

describe("MemoryInboxStore 并发竞态", () => {
  it("同一 eventId 100 路并发 claim 恰好一个 true", async () => {
    const store = new MemoryInboxStore();
    const results = await Promise.all(Array.from({ length: 100 }, () => store.claim("race-1")));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((r) => !r)).toHaveLength(99);
  });

  it("混合 id 并发：每个 id 恰好一个 true", async () => {
    const store = new MemoryInboxStore();
    const results = await Promise.all(
      Array.from({ length: 200 }, (_, i) => store.claim(`id-${i % 20}`))
    );
    expect(results.filter(Boolean)).toHaveLength(20);
  });
});

// ---------- JsonlTraceStore：崩溃半行 / 损坏数据 ----------

describe("JsonlTraceStore 损坏容错", () => {
  const dir = mkdtempSync(join(tmpdir(), "robust-trace-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const goodTrace = JSON.stringify({
    id: "trace-good-1",
    repo: "a/b",
    issueNumber: 1,
    agentVersion: "test",
    issueExcerpt: null,
    steps: [],
    finalActions: [],
    totalCost: 0,
    totalTokens: 0,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  });

  it("崩溃半行 + 坏 JSON 行：跳过计数，好行照常加载，库可用", async () => {
    const file = join(dir, "corrupt.jsonl");
    writeFileSync(
      file,
      `${goodTrace}\n{"id":"trace-cut","repo":"a/b","issueNu` + "\nnot-json-at-all\n\n",
      "utf8"
    );
    const store = new JsonlTraceStore(file);
    expect((await store.all()).map((t) => t.id)).toEqual(["trace-good-1"]);
    expect(store.corruptLinesSkipped).toBe(2); // 半行截断 + 纯垃圾行（空行被 trim 掉不计）
    // 库仍可写
    await store.append({ ...JSON.parse(goodTrace), id: "trace-good-2" });
    expect(await store.all()).toHaveLength(2);
  });

  it("合法 JSON 但缺 id 的行 → 跳过计数", async () => {
    const file = join(dir, "no-id.jsonl");
    writeFileSync(file, `{"repo":"a/b"}\n${goodTrace}\n`, "utf8");
    const store = new JsonlTraceStore(file);
    expect(store.corruptLinesSkipped).toBe(1);
    expect((await store.all()).map((t) => t.id)).toEqual(["trace-good-1"]);
  });

  it("空文件 / 不存在 → 空库可用", async () => {
    const empty = new JsonlTraceStore(join(dir, "empty.jsonl"));
    expect(await empty.all()).toHaveLength(0);
    expect(empty.corruptLinesSkipped).toBe(0);
    await empty.append(JSON.parse(goodTrace));
    expect(await empty.all()).toHaveLength(1);
  });
});

// ---------- extractJson 对抗输入 ----------

describe("extractJson 对抗输入", () => {
  it("全部垃圾输入返回 null，绝不抛异常", () => {
    for (const junk of [
      "",
      "   ",
      "not json",
      "{broken",
      '{"a":}',
      "{'单引号':1}",
      "{\"a\":1} 尾随文本 {\"b\":2}",
      "[1,2,3]",
      "null",
      "```json\n{\"ok\":true}\n``` 后记",
      '{"nested":{"deeply":{"circular-ish":"{\\"a\\":1}"}}}',
      "﻿{\"bom\":true}",
    ]) {
      expect(() => extractJson(junk)).not.toThrow();
    }
  });

  it("BOM / 围栏 / 前后废话中的合法 JSON 能被提取", () => {
    expect(extractJson("﻿{\"bom\":true}")).toEqual({ bom: true });
    expect(extractJson("```json\n{\"ok\":true}\n``` 后记")).toEqual({ ok: true });
    expect(extractJson("结果如下：{\"a\":1}")).toEqual({ a: 1 });
  });
});

// ---------- HTTP 层滥用（真实 server，随机端口） ----------

describe("webhook server HTTP 滥用", () => {
  const SECRET = "robust-test-secret";
  let server: Server | null = null;
  let port = 0;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((r) => server!.close(() => r()));
      server = null;
    }
  });

  function startServer(): Promise<number> {
    return new Promise((resolve) => {
      server = createWebhookServer({ secret: SECRET, handle: async () => OK_RESULT });
      server.listen(0, () => {
        port = (server!.address() as { port: number }).port;
        resolve(port);
      });
    });
  }

  function signed(body: string): string {
    return "sha256=" + createHmac("sha256", SECRET).update(body, "utf8").digest("hex");
  }

  async function raw(
    method: string,
    path: string,
    headers: Record<string, string>,
    body: string | Buffer
  ): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port, method, path, headers },
        (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
        }
      );
      req.on("error", reject);
      req.end(body);
    });
  }

  const OK_RESULT = { actions: [], steps: [], triage: null, escalated: false };

  it("超过 1MB 的 body → 413 拒绝（连接不被杀，响应可送达）", async () => {
    port = await startServer();
    const big = JSON.stringify({ ...{ action: "opened", issue: { number: 1 }, repository: { full_name: "a/b" } }, pad: "x".repeat(1_100_000) });
    const res = await raw("POST", "/webhook", {
      "content-type": "application/json",
      "x-github-delivery": "big-1",
      "x-github-event": "issues",
      "x-hub-signature-256": signed(big),
    }, big);
    expect(res.status).toBe(413);
  });

  it("GET/PUT /webhook → 404（方法滥用）", async () => {
    port = await startServer();
    expect((await raw("GET", "/webhook", {}, "")).status).toBe(404);
    expect((await raw("PUT", "/webhook", {}, "")).status).toBe(404);
    expect((await raw("POST", "/webhook/extra", {}, "")).status).toBe(404);
  });

  it("合法 JSON 但 payload 不是对象（数组/字符串）→ 202 ignored，服务不崩", async () => {
    port = await startServer();
    const body = JSON.stringify([1, 2, 3]);
    const res = await raw("POST", "/webhook", {
      "content-type": "application/json",
      "x-github-delivery": "junk-1",
      "x-github-event": "issues",
      "x-hub-signature-256": signed(body),
    }, body);
    expect(res.status).toBe(202);
    expect(JSON.parse(res.text)).toEqual({ status: "ignored" });
    // 服务仍活着
    expect((await raw("GET", "/healthz", {}, "")).status).toBe(200);
  });

  it("巨型 payload + unicode 内容 → 正常处理不崩（delivery id 恒为 ASCII UUID）", async () => {
    port = await startServer();
    const body = JSON.stringify({
      action: "opened",
      issue: { number: 1, title: "标题≤😀", body: "嵌套 ".repeat(5000) + JSON.stringify({ deep: Array.from({ length: 200 }, (_, i) => ({ i })) }) },
      repository: { full_name: "a/b" },
    });
    const res = await raw("POST", "/webhook", {
      "content-type": "application/json",
      "x-github-delivery": "uuid-ascii-0001",
      "x-github-event": "issues",
      "x-hub-signature-256": signed(body),
    }, body);
    expect(res.status).toBe(202);
    expect(JSON.parse(res.text)).toEqual({ status: "accepted" });
  });

  it("缺失 event 头但带 delivery → 400", async () => {
    port = await startServer();
    const res = await raw("POST", "/webhook", { "x-github-delivery": "d-1" }, "{}");
    expect(res.status).toBe(400);
  });
});
