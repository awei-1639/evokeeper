/**
 * 评测 harness 与门禁判定测试（W6 项目灵魂——这些用例锁死 R1 的执行语义）
 *
 * 五条门禁：dev 提升 ≥2pt / CI95 下界 >0 / holdout 回退 <1pt / adversarial 显式 skipped
 * （不阻塞发布但也不计通过，W8 起实检）/ 成本增幅 ≤10%。
 * 前置防御：跨 datasetVersion 拒绝、换模型未重跑基线拒绝（不可混同归因）。
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelConfig } from "@evokeeper/core";
import {
  bootstrapCI95,
  buildEvalMetrics,
  evaluateGate,
  loadGoldenSet,
  mainLabelOf,
  makeEvalRun,
  needsMoreInfoReport,
  triageAccuracy,
  triageMacroF1,
  type CaseResult,
} from "./index";

const MC: ModelConfig = { version: "mc-1.0", routing: { triage: "deepseek-v4-flash", answer: "qwen3-max", judge: "glm-4.6", consolidate: "deepseek-v4-pro", embed: "text-embedding-v4" } };

function result(caseId: string, goldMain: CaseResult["goldMain"], predMain: CaseResult["predMain"], cost = 0.004): CaseResult {
  return {
    caseId,
    goldMain,
    predMain,
    goldNeedsMoreInfo: false,
    predNeedsMoreInfo: false,
    costAmount: cost,
    durationMs: 1500,
  };
}

describe("指标计算", () => {
  it("accuracy：null 预测（解析失败）判错不豁免", () => {
    const cases = [
      result("1", "bug", "bug"),
      result("2", "bug", "question"),
      result("3", "bug", null),
      result("4", "bug", "bug"),
    ];
    expect(triageAccuracy(cases)).toBe(0.5);
  });

  it("宏 F1：可手算的两类场景", () => {
    const cases = [
      result("1", "bug", "bug"),
      result("2", "bug", "bug"),
      result("3", "question", "bug"),
      result("4", "question", "question"),
    ];
    // bug: P=2/3, R=1 → F1=0.8；question: P=1, R=1/2 → F1=2/3；宏平均 ≈ 0.7333
    expect(triageMacroF1(cases)).toBeCloseTo((0.8 + 2 / 3) / 2, 10);
  });

  it("nmi 附加维度单独报告", () => {
    const cases = [
      { ...result("1", "bug", "bug"), goldNeedsMoreInfo: true, predNeedsMoreInfo: true },
      { ...result("2", "bug", "bug"), goldNeedsMoreInfo: false, predNeedsMoreInfo: true },
    ];
    const r = needsMoreInfoReport(cases);
    expect(r).toEqual({ hit: 1, goldCount: 1, falsePositives: 1 });
  });

  it("bootstrap CI：确定性可复现；强分离数据下界 > 0", () => {
    const strong = [
      ...Array.from({ length: 90 }, (_, i) => result(`a${i}`, "bug", "bug")),
      ...Array.from({ length: 10 }, (_, i) => result(`b${i}`, "bug", "question")),
    ];
    const ci1 = bootstrapCI95(strong, 1000, 42);
    const ci2 = bootstrapCI95(strong, 1000, 42);
    expect(ci1).toEqual(ci2);
    expect(ci1!.lower).toBeGreaterThan(0);
  });
});

describe("loadGoldenSet", () => {
  it("过滤未定稿记录、split 过滤、goldMain 兜底 invalid、withQaOnly", () => {
    const dir = mkdtempSync(join(tmpdir(), "evokeeper-eval-"));
    const file = join(dir, "golden.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({ id: "gs-0001", repo: "r", issue_number: 1, labels_gold: ["bug"], split: "dev", difficulty: "easy" }),
        JSON.stringify({ id: "gs-0002", repo: "r", issue_number: 2, labels_gold: [], split: "dev" }),
        JSON.stringify({ id: "gs-0003", repo: "r", issue_number: 3, labels_gold: ["question", "needs-more-info"], split: "holdout", difficulty: "easy" }),
        JSON.stringify({ id: "gs-0004", repo: "r", issue_number: 4, labels_gold: ["invalid"], split: "dev", difficulty: "easy", qa: { question: "q", ideal_answer_outline: "o" } }),
      ].join("\n"),
      "utf8"
    );
    expect(loadGoldenSet(file)).toHaveLength(3);
    const holdout = loadGoldenSet(file, { split: "holdout" });
    expect(holdout.map((c) => c.id)).toEqual(["gs-0003"]);
    expect(holdout[0]?.goldMain).toBe("question");
    expect(holdout[0]?.goldNeedsMoreInfo).toBe(true);
    const withQa = loadGoldenSet(file, { withQaOnly: true });
    expect(withQa.map((c) => c.id)).toEqual(["gs-0004"]);
    expect(mainLabelOf(["kind-x"])).toBe("invalid");
  });
});

describe("evaluateGate（§7.2）", () => {
  const goodCases = (correctRate: number, cost = 0.004): CaseResult[] =>
    Array.from({ length: 100 }, (_, i) =>
      result(`c${i}`, "bug", i < correctRate * 100 ? "bug" : "question", cost)
    );

  const baseline = makeEvalRun({
    id: "run-base",
    candidateId: null,
    baselineRunId: null,
    datasetVersion: "v1",
    split: "dev",
    modelConfig: MC,
    cases: goodCases(0.6),
    ci95: { lower: -0.02, upper: 0.08 },
  });
  const baselineHoldout = makeEvalRun({
    id: "run-base-h",
    candidateId: null,
    baselineRunId: null,
    datasetVersion: "v1",
    split: "holdout",
    modelConfig: MC,
    cases: goodCases(0.62),
  });

  it("全部达标 → passed（adversarial 显式 skipped 不阻塞但也不计通过）", () => {
    const candidate = makeEvalRun({
      id: "run-cand",
      candidateId: "cand-1",
      baselineRunId: "run-base",
      datasetVersion: "v1",
      split: "dev",
      modelConfig: MC,
      cases: goodCases(0.7),
      ci95: { lower: 0.03, upper: 0.15 },
    });
    const d = evaluateGate({
      baseline,
      candidate,
      baselineHoldout,
      candidateHoldout: makeEvalRun({
        id: "run-cand-h",
        candidateId: "cand-1",
        baselineRunId: "run-base-h",
        datasetVersion: "v1",
        split: "holdout",
        modelConfig: MC,
        cases: goodCases(0.63),
      }),
    });
    expect(d.checks.find((c) => c.rule === "dev_improvement_ge_2pt")?.passed).toBe(true);
    expect(d.checks.find((c) => c.rule === "ci95_lower_bound_gt_0")?.passed).toBe(true);
    expect(d.checks.find((c) => c.rule === "holdout_no_regression_ge_1pt")?.passed).toBe(true);
    const adv = d.checks.find((c) => c.rule === "adversarial_no_worsening");
    expect(adv?.passed).toBe(false);
    expect(adv?.detail).toMatch(/^skipped：/);
    expect(d.checks.find((c) => c.rule === "cost_increase_le_10pct")?.passed).toBe(true);
    expect(d.passed).toBe(true);
  });

  it("提升不足 2pt → failed", () => {
    const candidate = makeEvalRun({
      id: "run-cand",
      candidateId: "cand-1",
      baselineRunId: "run-base",
      datasetVersion: "v1",
      split: "dev",
      modelConfig: MC,
      cases: goodCases(0.605),
      ci95: { lower: 0.01, upper: 0.05 },
    });
    const d = evaluateGate({ baseline, candidate, baselineHoldout, candidateHoldout: baselineHoldout });
    expect(d.checks.find((c) => c.rule === "dev_improvement_ge_2pt")?.passed).toBe(false);
    expect(d.passed).toBe(false);
  });

  it("holdout 缺失 → 显式阻塞（不默认通过）", () => {
    const candidate = makeEvalRun({
      id: "run-cand",
      candidateId: "cand-1",
      baselineRunId: "run-base",
      datasetVersion: "v1",
      split: "dev",
      modelConfig: MC,
      cases: goodCases(0.7),
      ci95: { lower: 0.03, upper: 0.15 },
    });
    const d = evaluateGate({ baseline, candidate });
    const holdout = d.checks.find((c) => c.rule === "holdout_no_regression_ge_1pt");
    expect(holdout?.passed).toBe(false);
    expect(holdout?.detail).toMatch(/^failed：/);
    expect(d.passed).toBe(false);
  });

  it("成本增幅 > 10% → failed", () => {
    const candidate = makeEvalRun({
      id: "run-cand",
      candidateId: "cand-1",
      baselineRunId: "run-base",
      datasetVersion: "v1",
      split: "dev",
      modelConfig: MC,
      cases: goodCases(0.7, 0.005), // +25%
      ci95: { lower: 0.03, upper: 0.15 },
    });
    const d = evaluateGate({ baseline, candidate, baselineHoldout, candidateHoldout: baselineHoldout });
    expect(d.checks.find((c) => c.rule === "cost_increase_le_10pct")?.passed).toBe(false);
    expect(d.passed).toBe(false);
  });

  it("跨 datasetVersion 直接整体拒绝", () => {
    const candidate = makeEvalRun({
      id: "run-cand",
      candidateId: "cand-1",
      baselineRunId: "run-base",
      datasetVersion: "v2",
      split: "dev",
      modelConfig: MC,
      cases: goodCases(0.9),
      ci95: { lower: 0.2, upper: 0.4 },
    });
    const d = evaluateGate({ baseline, candidate, baselineHoldout, candidateHoldout: baselineHoldout });
    expect(d.passed).toBe(false);
    expect(d.checks[0]?.detail).toContain("datasetVersion 不一致");
    expect(d.checks).toHaveLength(5);
  });

  it("换模型未重跑基线 → 拒绝（提升不可归因于经验）", () => {
    const candidate = makeEvalRun({
      id: "run-cand",
      candidateId: "cand-1",
      baselineRunId: "run-base",
      datasetVersion: "v1",
      split: "dev",
      modelConfig: { ...MC, version: "mc-1.1" },
      cases: goodCases(0.9),
      ci95: { lower: 0.2, upper: 0.4 },
    });
    const d = evaluateGate({ baseline, candidate, baselineHoldout, candidateHoldout: baselineHoldout });
    expect(d.passed).toBe(false);
    expect(d.checks[0]?.detail).toContain("modelConfig 版本不同");
  });

  it("holdout 回退 ≥ 1pt → failed", () => {
    const candidate = makeEvalRun({
      id: "run-cand",
      candidateId: "cand-1",
      baselineRunId: "run-base",
      datasetVersion: "v1",
      split: "dev",
      modelConfig: MC,
      cases: goodCases(0.7),
      ci95: { lower: 0.03, upper: 0.15 },
    });
    const candidateHoldout = makeEvalRun({
      id: "run-cand-h",
      candidateId: "cand-1",
      baselineRunId: "run-base-h",
      datasetVersion: "v1",
      split: "holdout",
      modelConfig: MC,
      cases: goodCases(0.5), // 基线 0.62 → 回退 12pt
    });
    const d = evaluateGate({ baseline, candidate, baselineHoldout, candidateHoldout });
    expect(d.checks.find((c) => c.rule === "holdout_no_regression_ge_1pt")?.passed).toBe(false);
    expect(d.passed).toBe(false);
  });
});

describe("makeEvalRun / buildEvalMetrics", () => {
  it("perCase 与 metrics 装配一致", () => {
    const run = makeEvalRun({
      id: "r",
      candidateId: null,
      baselineRunId: null,
      datasetVersion: "v1",
      split: "dev",
      modelConfig: MC,
      cases: [result("1", "bug", "bug"), result("2", "bug", null)],
    });
    expect(run.metrics.triageAccuracy).toBe(0.5);
    expect(run.perCase).toHaveLength(2);
    expect(run.perCase[1]?.triageCorrect).toBeNull(); // 解析失败 → null（不是 false 的语义混同）
    expect(run.ci95).not.toBeNull();
    expect(run.metrics.p50LatencyMs).toBeGreaterThan(0);
    expect(buildEvalMetrics([]).costPerIssue).toBe(0);
  });
});
