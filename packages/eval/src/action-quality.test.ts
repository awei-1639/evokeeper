import { describe, expect, it } from "vitest";
import {
  DEFAULT_ACTION_WEIGHTS,
  actionQualityReport,
  breakEvenProbability,
  calibrationBins,
  caseUtility,
  evaluateThreshold,
  expectedCalibrationError,
  pairedUtilityDeltaCI,
  selectOperatingPoint,
  utilityScores,
  weightSensitivity,
  type ActionCase,
} from "./action-quality";

const W = DEFAULT_ACTION_WEIGHTS;

/** 造样本：按 (correct, confidence) 生成 case */
function mk(rows: Array<[boolean | null, number | null]>): ActionCase[] {
  return rows.map(([correct, confidence], i) => ({
    caseId: `c-${String(i).padStart(3, "0")}`,
    correct,
    confidence,
  }));
}

describe("动作质量：代价矩阵与决策规则", () => {
  it("盈亏平衡置信度与权重一致（m=2,w=0.2 → 3/4.2）", () => {
    expect(breakEvenProbability(W)).toBeCloseTo(3 / 4.2, 10);
    // m 越大越不敢自动标；w 越大越敢自动标（转人工变贵）
    expect(breakEvenProbability({ mislabel: 4, wastedEscalation: 0.2 })).toBeGreaterThan(
      breakEvenProbability({ mislabel: 2, wastedEscalation: 0.2 })
    );
    expect(breakEvenProbability({ mislabel: 2, wastedEscalation: 1 })).toBeLessThan(
      breakEvenProbability({ mislabel: 2, wastedEscalation: 0.2 })
    );
  });

  it("四种结局的效用与代价矩阵一致", () => {
    const autoRight = mk([[true, 0.9]]);
    const autoWrong = mk([[false, 0.9]]);
    const escRight = mk([[true, 0.1]]);
    const escWrong = mk([[false, 0.1]]);
    const parseFail = mk([[null, null]]);
    const t = 0.5;
    expect(caseUtility(autoRight[0]!, t, W)).toBe(1);
    expect(caseUtility(autoWrong[0]!, t, W)).toBe(-W.mislabel);
    expect(caseUtility(escRight[0]!, t, W)).toBe(-W.wastedEscalation);
    expect(caseUtility(escWrong[0]!, t, W)).toBe(0);
    // 解析失败强制转人工：既无收益也无过失（不惩罚模型输出不可解析）
    expect(caseUtility(parseFail[0]!, t, W)).toBe(0);
  });

  it("阈值单调性：阈值越高自动化越少，误标也越少", () => {
    const cases = mk([
      [true, 0.95],
      [true, 0.8],
      [false, 0.7],
      [false, 0.55],
      [true, 0.4],
    ]);
    const low = evaluateThreshold(cases, 0, W);
    const high = evaluateThreshold(cases, 0.9, W);
    expect(low.autoCount).toBe(5);
    expect(high.autoCount).toBe(1);
    expect(high.mislabeled).toBeLessThanOrEqual(low.mislabeled);
    expect(low.escalationRecall).toBe(0);
    expect(high.escalationRecall).toBe(1);
  });

  it("counters 自洽：auto + escalate = 总数，拦截数 + 误标 = 会判错的条数", () => {
    const cases = mk([
      [true, 0.9],
      [false, 0.9],
      [true, 0.2],
      [false, 0.2],
      [null, null],
    ]);
    const p = evaluateThreshold(cases, 0.5, W);
    expect(p.autoCount + p.escalateCount).toBe(cases.length);
    expect(p.savedEscalations + p.mislabeled).toBe(2); // 两条会判错
    expect(p.wastedEscalations).toBe(1); // 一条对例被白看
    expect(p.autoPrecision).toBeCloseTo(0.5, 10);
    expect(p.escalationRecall).toBeCloseTo(0.5, 10);
  });
});

describe("动作质量：operating point 选择", () => {
  it("错例集中在低置信度时，转人工优于全自动", () => {
    // 高置信度全对，低置信度全错——置信度有区分度
    const cases = mk([
      [true, 0.95],
      [true, 0.92],
      [true, 0.9],
      [false, 0.6],
      [false, 0.58],
      [false, 0.55],
    ]);
    const best = selectOperatingPoint(cases, W)!;
    expect(best.threshold).toBeGreaterThan(0.6);
    expect(best.autoCount).toBe(3);
    expect(best.mislabeled).toBe(0);
    const allAuto = evaluateThreshold(cases, 0, W);
    expect(best.utilityPerCase).toBeGreaterThan(allAuto.utilityPerCase);
  });

  it("置信度无区分度时不会凭空造出中间阈值（只会全自动或全转人工）", () => {
    // 置信度全相同 → 阈值扫描找不到任何「只拦错例」的切点，
    // 最优解必定落在边界上；若内部阈值胜出，说明是噪声被当成了信号
    const cases = mk([
      [true, 0.8],
      [false, 0.8],
      [true, 0.8],
      [false, 0.8],
    ]);
    const best = selectOperatingPoint(cases, W)!;
    expect([0, cases.length]).toContain(best.autoCount);
    // 且它必须是两个边界里更好的那个（此处 50% 准确率配 m=2 → 自动标注是负期望）
    const allAuto = evaluateThreshold(cases, 0, W);
    const allEscalate = evaluateThreshold(cases, Number.POSITIVE_INFINITY, W);
    expect(best.utilityPerCase).toBeCloseTo(
      Math.max(allAuto.utilityPerCase, allEscalate.utilityPerCase),
      10
    );
  });

  it("全错时最优解是全转人工（效用 0 优于负效用）", () => {
    const cases = mk([
      [false, 0.9],
      [false, 0.95],
    ]);
    const best = selectOperatingPoint(cases, W)!;
    expect(best.utilityPerCase).toBeCloseTo(0, 10);
    expect(best.autoCount).toBe(0);
    expect(evaluateThreshold(cases, 0, W).utilityPerCase).toBeLessThan(0);
  });

  it("空输入返回 null，而不是伪造一个 0 效用报告", () => {
    expect(selectOperatingPoint([])).toBeNull();
  });
});

describe("动作质量：校准", () => {
  it("完美校准时 ECE ≈ 0，且每个桶内准确率≈平均置信度", () => {
    // 构造：置信度 0.55 的桶里 55% 判对
    const rows: Array<[boolean, number]> = [];
    for (let i = 0; i < 100; i++) rows.push([i < 55, 0.55]);
    for (let i = 0; i < 100; i++) rows.push([i < 90, 0.9]);
    const bins = calibrationBins(mk(rows), 10);
    expect(expectedCalibrationError(bins)).toBeLessThan(0.02);
  });

  it("过度自信（置信度 0.95 实际只对一半）会让 ECE 明显变大", () => {
    const rows: Array<[boolean, number]> = [];
    for (let i = 0; i < 100; i++) rows.push([i < 50, 0.95]);
    const bins = calibrationBins(mk(rows), 10);
    expect(expectedCalibrationError(bins)).toBeGreaterThan(0.4);
  });

  it("置信度缺失的 case 不进校准桶", () => {
    const bins = calibrationBins(mk([[true, null], [null, null], [true, 0.9]]), 10);
    expect(bins.reduce((a, b) => a + b.n, 0)).toBe(1);
  });
});

describe("动作质量：权重敏感性", () => {
  it("误标代价越高，最优阈值越高（更保守）", () => {
    const rows: Array<[boolean, number]> = [];
    for (let i = 0; i < 100; i++) rows.push([i < 80, i < 80 ? 0.85 : 0.7]);
    const cases = mk(rows);
    const grid = weightSensitivity(cases, [
      { mislabel: 1, wastedEscalation: 0.2 },
      { mislabel: 2, wastedEscalation: 0.2 },
      { mislabel: 4, wastedEscalation: 0.2 },
    ]);
    expect(grid[0]!.breakEven).toBeLessThan(grid[1]!.breakEven);
    expect(grid[1]!.breakEven).toBeLessThan(grid[2]!.breakEven);
    expect(grid[0]!.bestThreshold).toBeLessThanOrEqual(grid[2]!.bestThreshold);
  });
});

describe("动作质量：效用差的配对 bootstrap", () => {
  it("同一份数据 Δ=0、CI 落在 0 附近", () => {
    const cases = mk([
      [true, 0.9],
      [false, 0.9],
      [true, 0.6],
    ]);
    const scores = utilityScores(cases, 0.5, W);
    const d = pairedUtilityDeltaCI(scores, scores, 500)!;
    expect(d.delta).toBe(0);
    expect(d.lower).toBe(0);
    expect(d.upper).toBe(0);
  });

  it("候选把误标改成正确转人工 → Δ 为正且下界 > 0", () => {
    // 40 条：基线全置信 0.9 硬标、其中 16 条判错；候选同样判错但置信度降到 0.3 → 转人工
    const base: ActionCase[] = [];
    const cand: ActionCase[] = [];
    for (let i = 0; i < 40; i++) {
      const wrong = i % 5 === 0 ? true : false; // 8 条错
      base.push({ caseId: `c-${i}`, correct: !wrong, confidence: 0.9 });
      cand.push({ caseId: `c-${i}`, correct: !wrong, confidence: wrong ? 0.3 : 0.9 });
    }
    const d = pairedUtilityDeltaCI(utilityScores(base, 0.5, W), utilityScores(cand, 0.5, W), 1000)!;
    expect(d.delta).toBeGreaterThan(0);
    expect(d.lower).toBeGreaterThan(0);
    expect(d.matchedCases).toBe(40);
  });

  it("无对齐 case 时返回 null（调用方须判 fail，不得默认通过）", () => {
    const a = new Map([["x", 1]]);
    const b = new Map([["y", 1]]);
    expect(pairedUtilityDeltaCI(a, b)).toBeNull();
  });
});

describe("动作质量：整体报告", () => {
  it("报告含盈亏平衡点、两个参照系与敏感性表", () => {
    const cases = mk([
      [true, 0.9],
      [true, 0.88],
      [false, 0.6],
      [false, 0.3],
      [null, null],
    ]);
    const r = actionQualityReport(cases);
    expect(r.breakEven).toBeCloseTo(3 / 4.2, 10);
    expect(r.unparsable).toBe(1);
    // 全转人工并非 0 效用：本可判对的 2 条被推回人力，各记 −w
    expect(r.alwaysEscalate.utilityPerCase).toBeCloseTo((-W.wastedEscalation * 2) / 5, 10);
    expect(r.best!.utilityPerCase).toBeGreaterThanOrEqual(r.alwaysAuto.utilityPerCase);
    expect(r.sensitivity).toHaveLength(5);
  });
});
