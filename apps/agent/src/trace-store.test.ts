/**
 * 轨迹库测试（R3：全量落库含版本号与成本；重复落库必须抛错）
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HandleResult, IssueEvent } from "./index";
import { InMemoryTraceStore, JsonlTraceStore, buildTrace } from "./trace-store";

const EVENT: IssueEvent = {
  repo: "alibaba/nacos",
  issueNumber: 42,
  title: "t",
  body: "b",
};

const RESULT: HandleResult = {
  actions: [{ kind: "addLabels", labels: ["bug"] }],
  triage: null,
  escalated: false,
  steps: [
    {
      seq: 1,
      kind: "llm",
      promptVersion: "tp-1.2",
      model: "deepseek-v4-flash",
      inputTokens: 1500,
      outputTokens: 80,
      costAmount: 0.004,
      toolSummary: null,
      startedAt: "2026-09-28T10:00:00.000Z",
      durationMs: 1500,
    },
    {
      seq: 2,
      kind: "llm",
      promptVersion: "tp-1.2",
      model: "deepseek-v4-flash",
      inputTokens: 900,
      outputTokens: 40,
      costAmount: 0.002,
      toolSummary: null,
      startedAt: "2026-09-28T10:00:01.000Z",
      durationMs: 2500,
    },
  ],
};

describe("buildTrace", () => {
  it("成本与 token 全量累加，finishedAt 取各步结束最大值，agentVersion 记代码版本", () => {
    const trace = buildTrace(EVENT, RESULT, { id: "trace-d1" });
    expect(trace.id).toBe("trace-d1");
    expect(trace.repo).toBe("alibaba/nacos");
    expect(trace.issueNumber).toBe(42);
    expect(trace.agentVersion).toBe("0.1.0");
    expect(trace.totalCost).toBeCloseTo(0.006, 10);
    expect(trace.totalTokens).toBe(1500 + 80 + 900 + 40);
    expect(trace.startedAt).toBe("2026-09-28T10:00:00.000Z");
    // 第 2 步结束于 10:00:03.500，晚于 finishedAt 显式传入值的默认（首步开始）
    expect(trace.finishedAt).toBe("2026-09-28T10:00:03.500Z");
    expect(trace.finalActions).toEqual(RESULT.actions);
  });

  it("默认 id 带 trace- 前缀且唯一", () => {
    const a = buildTrace(EVENT, RESULT);
    const b = buildTrace(EVENT, RESULT);
    expect(a.id).toMatch(/^trace-/);
    expect(b.id).not.toBe(a.id);
  });
});

describe("TraceStore", () => {
  it("InMemory：append/get/listByIssue；同 id 重复落库抛错", async () => {
    const store = new InMemoryTraceStore();
    const t1 = buildTrace(EVENT, RESULT, { id: "trace-a" });
    const t2 = buildTrace({ ...EVENT, issueNumber: 43 }, RESULT, { id: "trace-b" });
    await store.append(t1);
    await store.append(t2);
    expect((await store.get("trace-a"))?.issueNumber).toBe(42);
    expect(await store.listByIssue("alibaba/nacos", 43)).toHaveLength(1);
    await expect(store.append(t1)).rejects.toThrow("重复");
  });

  it("Jsonl：跨实例持久化（重启恢复）+ 按 issue 过滤", async () => {
    const dir = mkdtempSync(join(tmpdir(), "evokeeper-trace-"));
    const file = join(dir, "traces.jsonl");
    const store1 = new JsonlTraceStore(file);
    await store1.append(buildTrace(EVENT, RESULT, { id: "trace-a" }));
    await store1.append(buildTrace({ ...EVENT, issueNumber: 43 }, RESULT, { id: "trace-b" }));

    const store2 = new JsonlTraceStore(file);
    expect(await store2.get("trace-a")).not.toBeNull();
    expect(await store2.listByIssue("alibaba/nacos", 42)).toHaveLength(1);
    expect(await store2.all()).toHaveLength(2);
    // 重复落库同样拒绝（幂等由 Inbox eventId 去重保证，这里是最后防线）
    await expect(store2.append(buildTrace(EVENT, RESULT, { id: "trace-a" }))).rejects.toThrow("重复");
  });
});
