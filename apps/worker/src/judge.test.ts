/**
 * 失败判别器测试（W3 DoD：判别规则 v1 上线）
 *
 * 锁死 design.md §5 契约：
 * 优先级命中即返回（显式失败 > 隐式失败 > 成功 > unclear）；
 * 窗口（14 天）外与未来信号忽略；
 * 无信号 → unclear，且 unclear 不进整理管线；
 * judgeRuleVersion 必须戳进结果（判别器自身可回溯）。
 */
import { describe, expect, it } from "vitest";
import type { Trace } from "@evokeeper/core";
import { JUDGE_RULE_SET_V1, eligibleForConsolidation, judgeTrace } from "./judge";

const TRACE: Trace = {
  id: "trace-1",
  repo: "alibaba/nacos",
  issueNumber: 1,
  agentVersion: "0.1.0",
  steps: [],
  finalActions: [],
  totalCost: 0,
  totalTokens: 0,
  startedAt: "2026-09-20T00:00:00.000Z",
  finishedAt: "2026-09-20T00:00:05.000Z",
};

const NOW = "2026-09-28T00:00:00.000Z";

function sig(kind: Parameters<typeof judgeTrace>[1][number]["kind"], occurredAt: string, detail?: string) {
  return { kind, occurredAt, detail };
}

describe("judgeTrace（jrv-1.0）", () => {
  it("显式失败优先级最高：即使同时有感谢也判 failure", () => {
    const j = judgeTrace(
      TRACE,
      [sig("author_thanks", "2026-09-27T00:00:00.000Z"), sig("maintainer_relabel", "2026-09-27T12:00:00.000Z")],
      { now: NOW }
    );
    expect(j.verdict).toBe("failure");
  });

  it("维护者纠正评论 / issue 重开 → failure", () => {
    expect(
      judgeTrace(TRACE, [sig("maintainer_correction_comment", "2026-09-27T00:00:00.000Z")], { now: NOW }).verdict
    ).toBe("failure");
    expect(judgeTrace(TRACE, [sig("issue_reopened", "2026-09-27T00:00:00.000Z")], { now: NOW }).verdict).toBe("failure");
  });

  it("隐式失败：作者追问不满足（≥2 次且未采纳）→ failure", () => {
    expect(
      judgeTrace(TRACE, [sig("author_followup_unsatisfied", "2026-09-27T00:00:00.000Z")], { now: NOW }).verdict
    ).toBe("failure");
  });

  it("正向信号 → success", () => {
    expect(judgeTrace(TRACE, [sig("author_thanks", "2026-09-27T00:00:00.000Z")], { now: NOW }).verdict).toBe("success");
    expect(
      judgeTrace(TRACE, [sig("issue_closed_by_author", "2026-09-27T00:00:00.000Z")], { now: NOW }).verdict
    ).toBe("success");
  });

  it("无信号 → unclear", () => {
    expect(judgeTrace(TRACE, [], { now: NOW }).verdict).toBe("unclear");
  });

  it("仅 no_reaction → unclear（无反应不等于失败）", () => {
    expect(judgeTrace(TRACE, [sig("no_reaction", "2026-09-27T00:00:00.000Z")], { now: NOW }).verdict).toBe("unclear");
  });

  it("窗口外信号忽略（15 天前的纠正不计，窗口内感谢生效）", () => {
    const j = judgeTrace(
      TRACE,
      [sig("maintainer_relabel", "2026-09-10T00:00:00.000Z"), sig("author_thanks", "2026-09-27T00:00:00.000Z")],
      { now: NOW }
    );
    expect(j.verdict).toBe("success");
    // 窗口外信号不进 JudgedTrace.reactions
    expect(j.reactions).toHaveLength(1);
  });

  it("未来时间戳信号忽略（采集时钟偏差防护）", () => {
    const j = judgeTrace(TRACE, [sig("maintainer_relabel", "2026-10-01T00:00:00.000Z")], { now: NOW });
    expect(j.verdict).toBe("unclear");
  });

  it("judgeRuleVersion 戳进结果；humanReviewed 默认 false", () => {
    const j = judgeTrace(TRACE, [], { now: NOW });
    expect(j.judgeRuleVersion).toBe("jrv-1.0");
    expect(j.humanReviewed).toBe(false);
    expect(JUDGE_RULE_SET_V1.version).toBe("jrv-1.0");
  });
});

describe("eligibleForConsolidation", () => {
  it("unclear 不进整理管线；success/failure 进", () => {
    const unclear = judgeTrace(TRACE, [], { now: NOW });
    const success = judgeTrace(TRACE, [sig("author_thanks", "2026-09-27T00:00:00.000Z")], { now: NOW });
    const failure = judgeTrace(TRACE, [sig("issue_reopened", "2026-09-27T00:00:00.000Z")], { now: NOW });
    expect(eligibleForConsolidation(unclear)).toBe(false);
    expect(eligibleForConsolidation(success)).toBe(true);
    expect(eligibleForConsolidation(failure)).toBe(true);
  });
});
