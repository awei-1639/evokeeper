/**
 * Inbox 行为测试
 *
 * 锁死 design.md §2/§9 的接入层约束：
 * eventId 幂等（至少一次投递，重复投递不重复处理）；
 * 重试退避 1m/5m/30m、最多 3 次后死信；
 * 事件映射只消费分诊相关事件（labeled/closed 不反应）；
 * HMAC 签名校验（配置 secret 后拒绝伪造投递）。
 */
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { HandleResult } from "./index";
import {
  MemoryInboxStore,
  RETRY_DELAYS_MS,
  createInboxProcessor,
  nextRetryDelayMs,
  parseIssueEvent,
  verifyWebhookSignature,
  type InboxStore,
  type WebhookDelivery,
} from "./inbox";
import { createWebhookServer } from "./webhook-server";

const OK_RESULT: HandleResult = { actions: [], steps: [], triage: null, escalated: false };

const OPENED_PAYLOAD = {
  action: "opened",
  issue: { number: 42, title: "注册实例丢失", body: "重启后实例消失", labels: [{ name: "kind/bug" }] },
  repository: { full_name: "alibaba/nacos" },
};

function delivery(overrides: Partial<WebhookDelivery> = {}): WebhookDelivery {
  return {
    eventId: "delivery-1",
    eventName: "issues",
    payload: OPENED_PAYLOAD,
    ...overrides,
  };
}

/** 手动调度器：收集任务，测试里按需触发，获得确定性 */
function manualScheduler() {
  const tasks: Array<{ delayMs: number; run: () => Promise<void> | void }> = [];
  return {
    tasks,
    schedule: (delayMs: number, task: () => Promise<void> | void) => tasks.push({ delayMs, run: task }),
    /** 触发最早一个任务（按入队顺序） */
    async tick() {
      const t = tasks.shift();
      if (t) await t.run();
    },
  };
}

describe("parseIssueEvent", () => {
  it("issues.opened 映射为 IssueEvent，rawLabels 仅随行不进上下文", () => {
    const ev = parseIssueEvent("issues", OPENED_PAYLOAD);
    expect(ev).toEqual({
      repo: "alibaba/nacos",
      issueNumber: 42,
      title: "注册实例丢失",
      body: "重启后实例消失",
      rawLabels: ["kind/bug"],
    });
  });

  it("issue_comment.created 带触发评论重分诊", () => {
    const payload = {
      action: "created",
      issue: { number: 42, title: "t", body: "b", labels: [] },
      comment: { user: { login: "alice" }, body: "补充日志如下" },
      repository: { full_name: "alibaba/nacos" },
    };
    const ev = parseIssueEvent("issue_comment", payload);
    expect(ev?.comments).toEqual([{ author: "alice", body: "补充日志如下" }]);
  });

  it("issues.labeled / issues.closed 不消费（维护者判定动作不反应）", () => {
    expect(parseIssueEvent("issues", { ...OPENED_PAYLOAD, action: "labeled" })).toBeNull();
    expect(parseIssueEvent("issues", { ...OPENED_PAYLOAD, action: "closed" })).toBeNull();
  });

  it("缺 issue/repository 或事件名不支持 → null", () => {
    expect(parseIssueEvent("push", OPENED_PAYLOAD)).toBeNull();
    expect(parseIssueEvent("issues", { action: "opened" })).toBeNull();
    expect(parseIssueEvent("issues", { action: "opened", issue: { number: 1 } })).toBeNull();
  });
});

describe("幂等与重试", () => {
  it("同一 eventId 重复投递只处理一次", async () => {
    const sched = manualScheduler();
    let calls = 0;
    const p = createInboxProcessor({
      store: new MemoryInboxStore(),
      handle: async () => {
        calls++;
        return OK_RESULT;
      },
      schedule: sched.schedule,
    });
    expect((await p.ingest(delivery())).status).toBe("accepted");
    expect((await p.ingest(delivery())).status).toBe("duplicate");
    await sched.tick();
    expect(calls).toBe(1);
  });

  it("首次处理失败按 1m/5m/30m 退避重试，成功即停", async () => {
    const sched = manualScheduler();
    let calls = 0;
    const p = createInboxProcessor({
      handle: async () => {
        calls++;
        if (calls < 3) throw new Error("LLM 超时");
        return OK_RESULT;
      },
      schedule: sched.schedule,
      onDeadLetter: () => {
        throw new Error("不应死信");
      },
    });
    const outcome = await p.ingest(delivery());
    expect(outcome.status).toBe("accepted");

    await sched.tick(); // 第 1 次处理（延迟 0ms）→ 失败
    expect(sched.tasks.at(-1)?.delayMs).toBe(RETRY_DELAYS_MS[0]);
    await sched.tick(); // 第 2 次 → 失败
    expect(sched.tasks.at(-1)?.delayMs).toBe(RETRY_DELAYS_MS[1]);
    await sched.tick(); // 第 3 次 → 成功
    expect(sched.tasks).toHaveLength(0);
    expect(calls).toBe(3);
  });

  it("重试耗尽（首次 + 3 次重试）后死信，不再调度", async () => {
    const sched = manualScheduler();
    let calls = 0;
    const dead: Array<{ eventId: string; failedAttempts: number }> = [];
    const p = createInboxProcessor({
      handle: async () => {
        calls++;
        throw new Error("持续失败");
      },
      schedule: sched.schedule,
      onDeadLetter: (d, _e, n) => dead.push({ eventId: d.eventId, failedAttempts: n }),
    });
    await p.ingest(delivery());
    for (let i = 0; i < 4; i++) await sched.tick(); // 首次 + 3 次重试（1m/5m/30m）
    expect(calls).toBe(4);
    expect(dead).toEqual([{ eventId: "delivery-1", failedAttempts: 4 }]);
    expect(sched.tasks).toHaveLength(0);
  });

  it("nextRetryDelayMs 边界：1→1m、3→30m、4→null", () => {
    expect(nextRetryDelayMs(1)).toBe(60_000);
    expect(nextRetryDelayMs(2)).toBe(300_000);
    expect(nextRetryDelayMs(3)).toBe(1_800_000);
    expect(nextRetryDelayMs(4)).toBeNull();
  });

  it("MemoryInboxStore 容量按 FIFO 淘汰最旧记录", async () => {
    const store: InboxStore = new MemoryInboxStore(2);
    expect(await store.claim("a")).toBe(true);
    expect(await store.claim("b")).toBe(true);
    expect(await store.claim("c")).toBe(true); // 淘汰 a
    expect(await store.claim("b")).toBe(false); // b 仍在
    expect(await store.claim("a")).toBe(true); // a 已淘汰，重新认领（同时挤掉最旧的 b）
  });
});

describe("verifyWebhookSignature", () => {
  const secret = "hmac-test-secret";
  const body = JSON.stringify(OPENED_PAYLOAD);
  const sign = (raw: string) => "sha256=" + createHmac("sha256", secret).update(raw, "utf8").digest("hex");

  it("合法签名通过，篡改 body 拒绝", () => {
    expect(verifyWebhookSignature(secret, body, sign(body))).toBe(true);
    expect(verifyWebhookSignature(secret, body + " ", sign(body))).toBe(false);
  });
  it("错误密钥 / 缺 sha256= 前缀 / 缺头 → 拒绝", () => {
    expect(verifyWebhookSignature(secret, body, sign(body).replace("sha256=", "sha1="))).toBe(false);
    expect(verifyWebhookSignature("other-secret", body, sign(body))).toBe(false);
    expect(verifyWebhookSignature(secret, body, undefined)).toBe(false);
  });
});

describe("webhook HTTP 接入", () => {
  let server: ReturnType<typeof createWebhookServer> | null = null;
  let baseUrl = "";
  let sched = manualScheduler();
  const handled: string[] = [];

  afterEach(async () => {
    server?.close();
    server = null;
    handled.length = 0;
    sched = manualScheduler();
  });

  async function start(secret: string) {
    server = createWebhookServer({
      secret,
      store: new MemoryInboxStore(),
      handle: async (ev) => {
        handled.push(`${ev.repo}#${ev.issueNumber}`);
        return OK_RESULT;
      },
      schedule: sched.schedule,
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (addr && typeof addr === "object") baseUrl = `http://127.0.0.1:${addr.port}`;
  }

  function post(path: string, opts: { body: string; headers?: Record<string, string> }) {
    return fetch(baseUrl + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...opts.headers },
      body: opts.body,
    });
  }

  it("合法签名投递 → 202 accepted，重复投递 → duplicate，处理被异步调度", async () => {
    const secret = "s3cret";
    await start(secret);
    const body = JSON.stringify(OPENED_PAYLOAD);
    const headers = {
      "x-github-delivery": "d-1",
      "x-github-event": "issues",
      "x-hub-signature-256": "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex"),
    };

    const res1 = await post("/webhook", { body, headers });
    expect(res1.status).toBe(202);
    expect(await res1.json()).toEqual({ status: "accepted" });

    const res2 = await post("/webhook", { body, headers });
    expect(res2.status).toBe(202);
    expect(await res2.json()).toEqual({ status: "duplicate" });

    await sched.tick();
    expect(handled).toEqual(["alibaba/nacos#42"]);
  });

  it("伪造签名 → 401；坏 JSON → 400；缺头 → 400；healthz → 200", async () => {
    const secret = "s3cret";
    await start(secret);
    const body = JSON.stringify(OPENED_PAYLOAD);

    const forged = await post("/webhook", {
      body,
      headers: { "x-github-delivery": "d-2", "x-github-event": "issues", "x-hub-signature-256": "sha256=deadbeef" },
    });
    expect(forged.status).toBe(401);

    const badJson = await post("/webhook", {
      body: "{not json",
      headers: {
        "x-github-delivery": "d-3",
        "x-github-event": "issues",
        "x-hub-signature-256": "sha256=" + createHmac("sha256", secret).update("{not json", "utf8").digest("hex"),
      },
    });
    expect(badJson.status).toBe(400);

    const noHeaders = await post("/webhook", { body });
    expect(noHeaders.status).toBe(400);

    const health = await fetch(baseUrl + "/healthz");
    expect(health.status).toBe(200);
    expect(handled).toEqual([]);
  });
});
