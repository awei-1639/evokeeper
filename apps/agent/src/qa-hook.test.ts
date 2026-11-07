/**
 * 问答钩子测试：提问判定 / bot 防自激 / 引用跨仓改写 / 低置信不发言
 *
 * LLM 全 mock（triage 与 answer 两个 purpose 分别应答），语料用临时 fixture，
 * 不碰网络、不依赖 .env.local。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { JsonCompletion, Llm, CompleteJsonArgs } from "@evokeeper/llm";
import { createQaAwareHandle, ANSWER_CONFIDENCE_THRESHOLD } from "./qa-hook";
import type { IssueEvent } from "./index";

const dir = mkdtempSync(join(tmpdir(), "qa-hook-"));
const corpusPath = join(dir, "corpus.jsonl");
writeFileSync(
  corpusPath,
  [
    JSON.stringify({
      id: "gs-x1",
      repo: "alibaba/nacos",
      issue_number: 1001,
      title: "客户端连不上服务端",
      body_excerpt: "报错 connection refused，服务端日志无异常",
      maintainer_replies: [{ author: "dev", body_excerpt: "检查 9848 端口与 grpc 配置" }],
    }),
  ].join("\n") + "\n",
  "utf8"
);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function mockLlm(answer: { answer: string; citations: string[]; confidence: number } | null) {
  const llm = {
    json: async <T,>(args: CompleteJsonArgs<T>): Promise<JsonCompletion<T>> => {
      if (args.purpose === "answer") {
        if (!answer) throw new Error("模拟 answer 失败");
        const raw = JSON.stringify(answer);
        return {
          ok: true,
          data: args.validate(JSON.parse(raw)).ok ? (JSON.parse(raw) as T) : null,
          raw,
          error: null,
          meta: {
            model: "mock-answer",
            promptVersion: "ap-test",
            inputTokens: 10,
            outputTokens: 10,
            costAmount: 0.001,
            durationMs: 5,
            startedAt: new Date().toISOString(),
            cacheHit: false,
            attempts: 1,
            repairTurns: 0,
          },
        };
      }
      // triage：固定判 question、高置信
      const triage = JSON.stringify({ labels: ["question"], rationale: "测试", confidence: 0.9 });
      return {
        ok: true,
        data: args.validate(JSON.parse(triage)).ok ? (JSON.parse(triage) as T) : null,
        raw: triage,
        error: null,
        meta: {
          model: "mock-triage",
          promptVersion: "tp-test",
          inputTokens: 10,
          outputTokens: 10,
          costAmount: 0.001,
          durationMs: 5,
          startedAt: new Date().toISOString(),
          cacheHit: false,
          attempts: 1,
          repairTurns: 0,
        },
      };
    },
  } as unknown as Llm;
  return llm;
}

const event = (comments: Array<{ author: string; body: string }>): IssueEvent => ({
  repo: "awei-1639/evokeeper",
  issueNumber: 3,
  title: "测试 issue",
  body: "正文",
  comments,
});

describe("createQaAwareHandle", () => {
  it("评论是提问 → 追加回答评论，引用改写为 语料仓库#N", async () => {
    const handle = createQaAwareHandle({
      llm: mockLlm({ answer: "检查 9848 端口，见 #1001", citations: ["#1001"], confidence: 0.85 }),
      corpusPath,
      log: () => {},
    });
    const result = await handle(event([{ author: "someone", body: "nacos 客户端连不上服务端怎么办？" }]));
    const comment = result.actions.find((a) => a.kind === "comment");
    expect(comment).toBeDefined();
    if (comment?.kind === "comment") {
      expect(comment.body).toContain("alibaba/nacos#1001");
      expect(comment.body).not.toMatch(/(?<!alibaba\/nacos)#1001/); // 不残留裸 #1001
      expect(comment.quoteRefs).toContain("#1001");
    }
    // 分诊步骤 + 回答步骤 = 2
    expect(result.steps).toHaveLength(2);
    expect(result.steps[1]?.model).toBe("mock-answer");
  });

  it("bot 自己的评论不触发回答（防自激）", async () => {
    const handle = createQaAwareHandle({
      llm: mockLlm({ answer: "x", citations: [], confidence: 0.9 }),
      corpusPath,
      log: () => {},
    });
    const result = await handle(event([{ author: "evokeeper-dev[bot]", body: "这是 Bot 的回答？" }]));
    expect(result.actions.find((a) => a.kind === "comment")).toBeUndefined();
  });

  it("非提问评论不回答（无问号/疑问词）", async () => {
    const handle = createQaAwareHandle({
      llm: mockLlm({ answer: "x", citations: [], confidence: 0.9 }),
      corpusPath,
      log: () => {},
    });
    const result = await handle(event([{ author: "someone", body: "已升级到 2.5.1，现象消失" }]));
    expect(result.actions.find((a) => a.kind === "comment")).toBeUndefined();
  });

  it("回答置信度低于阈值：留痕步骤但不发言", async () => {
    const handle = createQaAwareHandle({
      llm: mockLlm({ answer: "猜测性回答", citations: [], confidence: ANSWER_CONFIDENCE_THRESHOLD - 0.1 }),
      corpusPath,
      log: () => {},
    });
    const result = await handle(event([{ author: "someone", body: "怎么配置？" }]));
    expect(result.actions.find((a) => a.kind === "comment")).toBeUndefined();
    expect(result.steps).toHaveLength(2); // 回答的 LLM 步骤仍在（R3 留痕）
  });

  it("无评论的 issue 事件（opened）不进问答分支", async () => {
    const handle = createQaAwareHandle({
      llm: mockLlm(null),
      corpusPath,
      log: () => {},
    });
    const result = await handle({ ...event([]), comments: undefined });
    expect(result.steps).toHaveLength(1); // 只有分诊步骤
  });
});
