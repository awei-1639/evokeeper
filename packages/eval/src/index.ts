/**
 * 评测 harness 与门禁判定（W6，项目灵魂，红线 R1 的执行者）—— design.md §7
 *
 * 指标口径（§7.1）：
 * - 分诊主标签五类（bug/feature/question/duplicate/invalid）严格比对 → accuracy + 宏 F1；
 *   needs-more-info 单独报告，不混入主标签 F1；
 * - 主指标 triageAccuracy 做 bootstrap 重采样（默认 1000 次）得 95% CI；
 * - 每个 EvalRun 必须携带 modelConfig 快照 + datasetVersion；跨版本比较在门禁直接拒绝。
 *
 * 门禁判定（§7.2，五条全过才放行）：
 * 1. dev_improvement_ge_2pt        dev 主指标提升 ≥ 2pt；
 * 2. ci95_lower_bound_gt_0         bootstrap 95% CI 下界 > 0；
 * 3. holdout_no_regression_ge_1pt  holdout 回退 < 1pt（dev+holdout 双跑缺一不可）；
 * 4. adversarial_no_worsening      W8 前标记 skipped（detail 写明原因），不得默认 passed；
 * 5. cost_increase_le_10pct        单次成本增幅 ≤ 10%。
 * 外加第 6 道历史轨迹影子回放（W6 后续，独立实现）。
 */
import fs from "node:fs";
import type { EvalMetrics, EvalRun, GateDecision, ModelConfig } from "@evokeeper/core";

export { type EvalRun, type GateDecision } from "@evokeeper/core";

/** 分诊主标签五类（needs-more-info 不参与主标签指标，§7.1） */
export const MAIN_LABELS = ["bug", "feature", "question", "duplicate", "invalid"] as const;
export type MainLabel = (typeof MAIN_LABELS)[number];

export const DEV_IMPROVEMENT_MIN_PT = 2;
export const HOLDOUT_REGRESSION_MAX_PT = 1;
export const COST_INCREASE_MAX_PCT = 10;
export const BOOTSTRAP_ITERATIONS = 1000;

// ---------- golden set 加载 ----------

export interface GoldenCase {
  id: string;
  repo: string;
  issueNumber: number;
  labelsGold: string[];
  /** 分诊主标签（五类之一；invalid 为兜底） */
  goldMain: MainLabel;
  goldNeedsMoreInfo: boolean;
  question: string | null;
  idealAnswerOutline: string | null;
  difficulty: string;
  split: string;
}

export interface LoadGoldenSetOptions {
  /** 不传返回全部 split；holdout 只读由调用方保证（本函数不改任何数据） */
  split?: "dev" | "holdout";
  /** 仅加载有 QA 的记录（回答评测轨道） */
  withQaOnly?: boolean;
}

export function mainLabelOf(labels: readonly string[]): MainLabel {
  const main = labels.find((l) => (MAIN_LABELS as readonly string[]).includes(l));
  return (main as MainLabel | undefined) ?? "invalid";
}

export function loadGoldenSet(path: string, options: LoadGoldenSetOptions = {}): GoldenCase[] {
  const cases: GoldenCase[] = [];
  for (const line of fs.readFileSync(path, "utf8").trim().split("\n")) {
    if (!line) continue;
    const r = JSON.parse(line) as Record<string, unknown>;
    const labelsGold = Array.isArray(r["labels_gold"]) ? (r["labels_gold"] as string[]) : [];
    if (labelsGold.length === 0) continue; // 未定稿的草稿不进评测集
    if (options.split && r["split"] !== options.split) continue;
    const qa = r["qa"] as Record<string, unknown> | null | undefined;
    if (options.withQaOnly && !qa) continue;
    cases.push({
      id: String(r["id"] ?? `unknown-${cases.length}`),
      repo: String(r["repo"] ?? ""),
      issueNumber: Number(r["issue_number"]),
      labelsGold,
      goldMain: mainLabelOf(labelsGold),
      goldNeedsMoreInfo: labelsGold.includes("needs-more-info"),
      question: qa && typeof qa["question"] === "string" ? (qa["question"] as string) : null,
      idealAnswerOutline:
        qa && typeof qa["ideal_answer_outline"] === "string"
          ? (qa["ideal_answer_outline"] as string)
          : null,
      difficulty: String(r["difficulty"] ?? "medium"),
      split: String(r["split"] ?? "dev"),
    });
  }
  return cases;
}

// ---------- 指标计算 ----------

export interface CaseResult {
  caseId: string;
  goldMain: MainLabel;
  /** 模型输出的主标签；null = 解析失败（判错，不豁免，§7.1） */
  predMain: MainLabel | null;
  goldNeedsMoreInfo: boolean;
  predNeedsMoreInfo: boolean;
  costAmount: number;
  durationMs: number;
}

export function triageAccuracy(cases: readonly CaseResult[]): number {
  if (cases.length === 0) return 0;
  const correct = cases.filter((c) => c.predMain === c.goldMain).length;
  return correct / cases.length;
}

/** 宏 F1：五类主标签各算 F1 后取平均（类不平衡下比 accuracy 更稳） */
export function triageMacroF1(cases: readonly CaseResult[]): number {
  const f1s: number[] = [];
  for (const label of MAIN_LABELS) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const c of cases) {
      const gold = c.goldMain === label;
      const pred = c.predMain === label;
      if (pred && gold) tp++;
      else if (pred && !gold) fp++;
      else if (!pred && gold) fn++;
    }
    if (tp + fp === 0 && tp + fn === 0) continue; // 该类在 gold 与 pred 中均不存在
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    f1s.push(precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0);
  }
  return f1s.length > 0 ? f1s.reduce((a, b) => a + b, 0) / f1s.length : 0;
}

/** needs-more-info 单独报告：命中率与误报数（§7.1 附加维度） */
export function needsMoreInfoReport(cases: readonly CaseResult[]): {
  hit: number;
  goldCount: number;
  falsePositives: number;
} {
  const goldRows = cases.filter((c) => c.goldNeedsMoreInfo);
  return {
    hit: goldRows.filter((c) => c.predNeedsMoreInfo).length,
    goldCount: goldRows.length,
    falsePositives: cases.filter((c) => !c.goldNeedsMoreInfo && c.predNeedsMoreInfo).length,
  };
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((values.length * p) / 100))] ?? 0;
}

/**
 * bootstrap 95% CI（主指标 triageAccuracy）。seed 固定可复现（mulberry32）。
 */
export function bootstrapCI95(
  cases: readonly CaseResult[],
  iterations = BOOTSTRAP_ITERATIONS,
  seed = 42
): { lower: number; upper: number } | null {
  if (cases.length === 0) return null;
  const correct = cases.map((c) => (c.predMain === c.goldMain ? 1 : 0));
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const n = correct.length;
  const stats: number[] = [];
  for (let it = 0; it < iterations; it++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += correct[Math.floor(rand() * n)] ?? 0;
    }
    stats.push(sum / n);
  }
  stats.sort((x, y) => x - y);
  const lower = stats[Math.floor(iterations * 0.025)] ?? 0;
  const upper = stats[Math.min(stats.length - 1, Math.floor(iterations * 0.975))] ?? 0;
  return { lower, upper };
}

export function buildEvalMetrics(cases: readonly CaseResult[]): EvalMetrics {
  return {
    triageAccuracy: triageAccuracy(cases),
    triageMacroF1: triageMacroF1(cases),
    answerQuality: 0,
    p50LatencyMs: percentile(cases.map((c) => c.durationMs), 50),
    p95LatencyMs: percentile(cases.map((c) => c.durationMs), 95),
    costPerIssue:
      cases.length > 0 ? cases.reduce((a, c) => a + c.costAmount, 0) / cases.length : 0,
    adversarialPassRate: null,
  };
}

// ---------- EvalRun 装配辅助 ----------

export function makeEvalRun(args: {
  id: string;
  candidateId: string | null;
  baselineRunId: string | null;
  datasetVersion: string;
  split: EvalRun["split"];
  modelConfig: ModelConfig;
  cases: readonly CaseResult[];
  ci95?: { lower: number; upper: number } | null;
  ranAt?: string;
}): EvalRun {
  return {
    id: args.id,
    candidateId: args.candidateId,
    baselineRunId: args.baselineRunId,
    datasetVersion: args.datasetVersion,
    split: args.split,
    modelConfig: args.modelConfig,
    metrics: buildEvalMetrics(args.cases),
    ci95: args.ci95 ?? bootstrapCI95(args.cases),
    perCase: args.cases.map((c) => ({
      caseId: c.caseId,
      passed: c.predMain === c.goldMain,
      triageCorrect: c.predMain === null ? null : c.predMain === c.goldMain,
      answerScore: null,
    })),
    ranAt: args.ranAt ?? new Date().toISOString(),
  };
}

// ---------- 门禁判定（§7.2 五条全过才放行） ----------

export interface GateInput {
  /** dev 集基线 run */
  baseline: EvalRun;
  /** dev 集候选 run */
  candidate: EvalRun;
  /** holdout 双评测（发布要求 dev+holdout 双跑，缺一不可） */
  baselineHoldout?: EvalRun;
  candidateHoldout?: EvalRun;
  /** W8 前不传：adversarial 检查记 skipped（不计通过） */
  adversarialPassRate?: number;
  /**
   * 候选与基线的 modelConfig 版本不同时必须显式声明——
   * 换模型=换行为，提升不可归因于经验本身（§7.1），声明后门禁依然拒收，
   * 要求先用新模型重跑基线生成新 baselineRunId。
   */
  modelConfigChanged?: boolean;
  now?: string;
}

const SKIP_DETAIL = "同上，前置防御失败，跳过评分";

function gateFailedAll(candidateId: string, firstDetail: string, now: string): GateDecision {
  const rules: GateDecision["checks"][number]["rule"][] = [
    "dev_improvement_ge_2pt",
    "ci95_lower_bound_gt_0",
    "holdout_no_regression_ge_1pt",
    "adversarial_no_worsening",
    "cost_increase_le_10pct",
  ];
  return {
    evalRunId: candidateId,
    passed: false,
    checks: rules.map((rule, i) => ({
      rule,
      passed: false,
      detail: i === 0 ? firstDetail : SKIP_DETAIL,
    })),
    decidedAt: now,
  };
}

export function evaluateGate(input: GateInput): GateDecision {
  const { baseline, candidate } = input;
  const now = input.now ?? new Date().toISOString();
  const checks: GateDecision["checks"] = [];
  const add = (rule: GateDecision["checks"][number]["rule"], passed: boolean, detail: string) =>
    checks.push({ rule, passed, detail });

  // 前置防御 1：禁止跨数据集版本比较（§7.1）
  if (candidate.datasetVersion !== baseline.datasetVersion) {
    return gateFailedAll(
      candidate.id,
      `datasetVersion 不一致（${baseline.datasetVersion} vs ${candidate.datasetVersion}）：禁止跨数据集版本比较指标`,
      now
    );
  }

  // 前置防御 2：换模型 = 换行为，未重跑基线前提升不可归因（§7.1）
  if (
    candidate.modelConfig.version !== baseline.modelConfig.version &&
    input.modelConfigChanged !== true
  ) {
    return gateFailedAll(
      candidate.id,
      `modelConfig 版本不同（${baseline.modelConfig.version} → ${candidate.modelConfig.version}）：必须以新模型重跑基线生成新 baselineRunId，不得混同归因`,
      now
    );
  }
  if (input.modelConfigChanged === true) {
    return gateFailedAll(
      candidate.id,
      "modelConfig 已变更：换模型带来的提升与经验发布的提升不可混同归因，须先重跑基线",
      now
    );
  }

  // 1. dev 主指标提升 ≥ 2pt
  const deltaPt = (candidate.metrics.triageAccuracy - baseline.metrics.triageAccuracy) * 100;
  add(
    "dev_improvement_ge_2pt",
    deltaPt >= DEV_IMPROVEMENT_MIN_PT,
    `dev triageAccuracy ${(baseline.metrics.triageAccuracy * 100).toFixed(1)}% → ${(candidate.metrics.triageAccuracy * 100).toFixed(1)}%（${deltaPt >= 0 ? "+" : ""}${deltaPt.toFixed(2)}pt），要求 ≥ ${DEV_IMPROVEMENT_MIN_PT}pt`
  );

  // 2. bootstrap 95% CI 下界 > 0（基于候选 dev run）
  const ci = candidate.ci95;
  add(
    "ci95_lower_bound_gt_0",
    ci !== null && ci.lower > 0,
    ci === null
      ? "候选 run 未提供 ci95（bootstrap 重采样未执行）"
      : `CI95 = [${(ci.lower * 100).toFixed(2)}pt, ${(ci.upper * 100).toFixed(2)}pt]，下界须 > 0`
  );

  // 3. holdout 回退 < 1pt（需 holdout 双评测）
  if (input.baselineHoldout && input.candidateHoldout) {
    if (input.baselineHoldout.datasetVersion !== candidate.datasetVersion) {
      add("holdout_no_regression_ge_1pt", false, "holdout run 的 datasetVersion 与 dev 不一致，拒绝比较");
    } else {
      const dropPt =
        (input.baselineHoldout.metrics.triageAccuracy -
          input.candidateHoldout.metrics.triageAccuracy) *
        100;
      add(
        "holdout_no_regression_ge_1pt",
        dropPt < HOLDOUT_REGRESSION_MAX_PT,
        `holdout triageAccuracy ${(input.baselineHoldout.metrics.triageAccuracy * 100).toFixed(1)}% → ${(input.candidateHoldout.metrics.triageAccuracy * 100).toFixed(1)}%（${dropPt >= 0 ? "回退" : "提升"} ${Math.abs(dropPt).toFixed(2)}pt），回退须 < ${HOLDOUT_REGRESSION_MAX_PT}pt`
      );
    }
  } else {
    add(
      "holdout_no_regression_ge_1pt",
      false,
      "failed：未提供 holdout 双评测（发布要求 dev+holdout 双跑），不默认通过"
    );
  }

  // 4. adversarial：W8 前必须 skipped，不得默认 passed
  if (input.adversarialPassRate === undefined) {
    add(
      "adversarial_no_worsening",
      false,
      "skipped：对抗样本集 W8 启用，未提供 adversarialPassRate（显式跳过，不计通过）"
    );
  } else {
    const base = baseline.metrics.adversarialPassRate;
    add(
      "adversarial_no_worsening",
      base === null || input.adversarialPassRate >= base,
      `对抗通过率 ${base === null ? "基线无数据" : `${(base * 100).toFixed(1)}%`} → ${(input.adversarialPassRate * 100).toFixed(1)}%`
    );
  }

  // 5. 成本增幅 ≤ 10%
  const costPct =
    baseline.metrics.costPerIssue > 0
      ? ((candidate.metrics.costPerIssue - baseline.metrics.costPerIssue) /
          baseline.metrics.costPerIssue) *
        100
      : 0;
  add(
    "cost_increase_le_10pct",
    costPct <= COST_INCREASE_MAX_PCT,
    `单条成本 ${baseline.metrics.costPerIssue.toFixed(5)} → ${candidate.metrics.costPerIssue.toFixed(5)}（${costPct >= 0 ? "+" : ""}${costPct.toFixed(1)}%），上限 +${COST_INCREASE_MAX_PCT}%`
  );

  // 整体判定：所有检查通过才算放行；唯一的例外是 adversarial 的显式 skipped
  // （W8 前对抗集不存在，§7.2 要求 skipped 而非默认 passed——它不阻塞发布但也不计通过；
  //  其余任何 skipped/failed 一律阻塞。holdout 缺失等用 "failed：" 前缀显式阻塞）
  const passed = checks.every((c) => c.passed || c.detail.startsWith("skipped："));
  return { evalRunId: candidate.id, passed, checks, decidedAt: now };
}
