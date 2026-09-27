/**
 * 失败判别器（W3）—— design.md §5，依据 D4
 *
 * 规则按优先级升序（1 最高）命中即返回；窗口（windowDays=14 天）外的信号忽略；
 * 窗口内无信号或仅有 no_reaction → unclear。
 *
 * 关键决策（design-notes D4 / W1 补充决策）：unclear 轨迹**不进整理管线**，
 * 只进周报"低信号池"供人工抽样——无反应既不是失败也不等于成功，
 * 当失败处理会污染归纳方向。
 *
 * 判别器自身版本化（judgeRuleVersion）；修订规则必须递增版本，禁止原地改。
 */
import type { FailureVerdict, JudgeRuleSet, JudgedTrace, ReactionSignal, Trace } from "@evokeeper/core";

export const JUDGE_RULE_SET_V1: JudgeRuleSet = {
  version: "jrv-1.0",
  rules: [
    { signal: "maintainer_relabel", verdict: "failure", priority: 1 },
    { signal: "maintainer_correction_comment", verdict: "failure", priority: 1 },
    { signal: "issue_reopened", verdict: "failure", priority: 1 },
    { signal: "author_followup_unsatisfied", verdict: "failure", priority: 2 },
    { signal: "author_thanks", verdict: "success", priority: 3 },
    { signal: "issue_closed_by_author", verdict: "success", priority: 3 },
    { signal: "no_reaction", verdict: "unclear", priority: 4 },
  ],
  windowDays: 14,
  humanReviewSampleSize: 20,
};

export interface JudgeOptions {
  ruleSet?: JudgeRuleSet;
  /** 时钟注入（测试与可重放要求） */
  now?: string;
}

/**
 * 对一条轨迹做失败判别：窗口内信号按规则优先级取最优先命中；
 * 无命中（含窗口为空）→ unclear。
 */
export function judgeTrace(trace: Trace, reactions: readonly ReactionSignal[], opts: JudgeOptions = {}): JudgedTrace {
  const ruleSet = opts.ruleSet ?? JUDGE_RULE_SET_V1;
  const now = opts.now ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  const cutoff = nowMs - ruleSet.windowDays * 86_400_000;

  const inWindow = reactions.filter((r) => {
    const at = Date.parse(r.occurredAt);
    return at >= cutoff && at <= nowMs;
  });

  let verdict: FailureVerdict = "unclear";
  let bestPriority = Number.POSITIVE_INFINITY;
  for (const r of inWindow) {
    const rule = ruleSet.rules.find((x) => x.signal === r.kind);
    if (!rule || rule.priority >= bestPriority) continue;
    bestPriority = rule.priority;
    verdict = rule.verdict;
  }

  return {
    trace,
    reactions: inWindow,
    verdict,
    judgeRuleVersion: ruleSet.version,
    humanReviewed: false,
  };
}

/** 是否进入整理管线：unclear 一律不进（D4/W1 决策），只进周报低信号池 */
export function eligibleForConsolidation(judged: JudgedTrace): boolean {
  return judged.verdict !== "unclear";
}
