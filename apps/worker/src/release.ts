/**
 * 发布与回滚（W6）—— design.md §8
 *
 * 版本规则：v{N} 为经验版本（与代码版本分离）；`ReleaseVersion.diff` 必须包含
 * skill/prompt/memory 三槽位的完整快照（无 diff 的发布拒绝落库）。
 * 灰度：canaryScope = 单仓库或 20% 流量，观察 48h（CanaryMetrics）。
 * 转全量：无负面信号且成本在预算内；回滚：任一负面信号 → 新记录 rollbackOf 指向
 * 被回滚版本，切回上一版本完整快照（O(1) 切换，不是反向计算）。
 *
 * R1 铁律：gateDecision.passed !== true 的发布请求直接抛错，永不落库。
 * 本模块是纯状态机（无 IO）；持久化由调用方接 JSONL/PG。
 */
import type { CanaryMetrics, ExperienceCandidate, GateDecision, ReleaseVersion } from "@evokeeper/core";

export const CANARY_OBSERVE_HOURS = 48;
export const CANARY_MIN_SAMPLE = 30;
/** 灰度阈值（provisional：W4 真实流量后按分布校准，改动需在 design.md 登记） */
export const HUMAN_CORRECTION_RATE_MAX = 0.05;
export const ESCALATE_RATE_MAX = 0.2;

export interface ReleaseDiff {
  /** 技能文件槽位（.md 正文），无则 null */
  skill: string | null;
  /** prompt 片段槽位（提示词 diff），无则 null */
  prompt: string | null;
  /** 记忆条目槽位（增删改清单），无则 null */
  memory: string | null;
}

export function hasContent(diff: ReleaseDiff): boolean {
  return [diff.skill, diff.prompt, diff.memory].some((s) => s !== null && s.trim().length > 0);
}

export interface CreateReleaseArgs {
  version: string;
  candidate: ExperienceCandidate;
  gateDecision: GateDecision;
  diff: ReleaseDiff;
  canaryScope?: string;
  now?: string;
}

/**
 * 创建灰度发布记录。两条硬校验：
 * 1. 门禁必须 PASSED（R1：不经门禁的经验永不生效）；
 * 2. diff 必须至少有一个槽位有内容（无 diff 的发布拒绝落库，§8）。
 */
export function createRelease(args: CreateReleaseArgs): ReleaseVersion {
  if (args.gateDecision.passed !== true) {
    throw new Error(
      `R1 违规：GateDecision 未通过（${args.gateDecision.checks.filter((c) => !c.passed).length} 项未过），禁止发布`
    );
  }
  if (args.candidate.status !== "approved") {
    throw new Error(`候选状态必须是 approved（人工评审通过），当前 ${args.candidate.status}`);
  }
  if (!hasContent(args.diff)) {
    throw new Error("diff 三槽位全空：无 diff 的发布拒绝落库（§8）");
  }
  if (args.candidate.evidenceTraceIds.length === 0) {
    throw new Error("候选证据链为空（R1 配套约束）");
  }
  return {
    version: args.version,
    candidateId: args.candidate.id,
    diff: JSON.stringify(args.diff),
    gateDecisionId: args.gateDecision.evalRunId,
    status: "canary",
    canaryScope: args.canaryScope ?? "pct:20",
    releasedAt: args.now ?? new Date().toISOString(),
    rollbackOf: null,
  };
}

/**
 * 灰度裁决（48h 观察窗口结束时调用）：
 * - 样本不足 → pending（继续观察）；
 * - 任一负面信号（维护者纠正率超限 / escalate 率超限 / 负面反应 > 0）→ rollback；
 * - 否则 → promote。
 */
export function decideCanary(
  metrics: CanaryMetrics,
  opts: { minSampleSize?: number } = {}
): "promote" | "rollback" | "pending" {
  const min = opts.minSampleSize ?? CANARY_MIN_SAMPLE;
  if (metrics.sampleSize < min) return "pending";
  if (metrics.negativeReactionCount > 0) return "rollback";
  if (metrics.humanCorrectionRate > HUMAN_CORRECTION_RATE_MAX) return "rollback";
  if (metrics.escalateRate > ESCALATE_RATE_MAX) return "rollback";
  return "promote";
}

/**
 * 回滚：被回滚版本标记 rolled_back；同时产生一条新记录，
 * diff = 上一稳定版本的完整快照（O(1) 切回），rollbackOf 指向被回滚版本。
 */
export function createRollback(
  failed: ReleaseVersion,
  restoreFrom: ReleaseVersion,
  nextVersion: string,
  now: string = new Date().toISOString()
): { failed: ReleaseVersion; rollback: ReleaseVersion } {
  if (failed.status === "rolled_back") {
    throw new Error(`版本 ${failed.version} 已是回滚状态`);
  }
  return {
    failed: { ...failed, status: "rolled_back" },
    rollback: {
      version: nextVersion,
      candidateId: restoreFrom.candidateId,
      diff: restoreFrom.diff,
      gateDecisionId: restoreFrom.gateDecisionId,
      status: "rolled_back",
      canaryScope: null,
      releasedAt: now,
      rollbackOf: failed.version,
    },
  };
}
