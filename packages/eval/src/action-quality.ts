/**
 * 动作质量指标（W6 补充，design.md §7.4）—— 主指标从「标签准确率」转向「决策效用」
 *
 * 为什么需要它：accuracy 把「转人工」和「标错」记成同一个错误，导致
 * 模型在一道 50/50 的题上两种选择得分完全相同。实测约束（§7.3）已经证明
 * 剩余错误主要来自文本里没有的信息（duplicate 需原号、nmi 需维护者历史），
 * 在这类 case 上继续优化标签只会得到噪声级收益；而「识别自己不会、交给人工」
 * 是一个效应量 10pt 级、且可用维护者真实反应自监督的目标。
 *
 * 计分（每条 issue，单位 = 「一次正确的自动分诊」）：
 * - 自动标注且判对            +1       省下一次人工分诊
 * - 自动标注且判错            −m       人工要发现并改正，且错误标签会误导提问者
 * - 转人工（本可判对）        −w       人工白扫一眼，且把本可自动化的收益拱手让出
 * - 转人工（本会判错）         0        人工照常处理，但错误标签已被拦下
 * - 解析失败（无法自动标注）   0        强制转人工，既无收益也无过失
 *
 * 注意参考点不是「什么都不做」而是「人工逐条分诊」：因此全转人工的效用是
 * −w ×（本可判对的比例）而非 0——一个把八成 case 推回人力的 Agent 记 0 分
 * 并不合理，它确实让人多扫了一眼。
 *
 * 由此得到与代价矩阵一致的决策规则（不靠调参）：
 *   p·1 + (1−p)·(−m) > p·(−w) + (1−p)·0
 *   ⇔ p > (1 + m) / (2 + m + w) = p*
 * 默认 m=2、w=0.2 → p* ≈ 0.714：把握不到七成才该转人工。
 *
 * 权重是主观的，所以报告必须同时给出 p* 与权重敏感性表——只报一个
 * 「效用提升 X」而不说代价假设，等于把结论藏进参数里。
 */

export interface ActionQualityWeights {
  /** 自动标注判错的代价（相对「一次正确自动分诊」） */
  mislabel: number;
  /** 转人工但本可判对的代价（人工白看） */
  wastedEscalation: number;
}

/**
 * 默认权重：m=2 表示一次误标要用两次正确分诊才能补回来（需人工发现+改正，
 * 且错误标签会影响提问者对问题的描述）；w=0.2 表示人工扫一眼即可确认
 * Agent 判断无误（只需点击通过，不需重新判断）。
 */
export const DEFAULT_ACTION_WEIGHTS: ActionQualityWeights = {
  mislabel: 2,
  wastedEscalation: 0.2,
};

/** 一条 case 在动作质量口径下的输入 */
export interface ActionCase {
  caseId: string;
  /** 主标签是否与 gold 一致；null = 解析失败（无法自动标注 → 强制转人工） */
  correct: boolean | null;
  /** 模型自报置信度 0-1；null = 未采集/不可用 */
  confidence: number | null;
}

/** 决策规则：置信度低于阈值即转人工 */
export interface OperatingPoint {
  /** 阈值 τ：confidence ≥ τ 才自动标注 */
  threshold: number;
  autoCount: number;
  escalateCount: number;
  /** 自动标注占全部 case 的比例 */
  autoCoverage: number;
  /** 自动标注的精确率（判错即误标） */
  autoPrecision: number;
  /** 误标数 */
  mislabeled: number;
  /** 转人工中「本会判对」的数量（白看） */
  wastedEscalations: number;
  /** 转人工中「本会判错」的数量（正确拦截） */
  savedEscalations: number;
  /** 该会判错的 case 被成功拦下的比例 */
  escalationRecall: number;
  /** 每条 issue 的平均效用 */
  utilityPerCase: number;
}

/** 与代价矩阵一致的盈亏平衡置信度：p > p* 才值得自动标注 */
export function breakEvenProbability(w: ActionQualityWeights = DEFAULT_ACTION_WEIGHTS): number {
  return (1 + w.mislabel) / (2 + w.mislabel + w.wastedEscalation);
}

/** 单条 case 的效用（解析失败 = 强制转人工 = 0） */
export function caseUtility(
  c: ActionCase,
  threshold: number,
  w: ActionQualityWeights = DEFAULT_ACTION_WEIGHTS
): number {
  if (c.correct === null) return 0;
  const auto = c.confidence !== null && c.confidence >= threshold;
  if (auto) return c.correct ? 1 : -w.mislabel;
  return c.correct ? -w.wastedEscalation : 0;
}

/** 在给定阈值下评估一个 operating point */
export function evaluateThreshold(
  cases: readonly ActionCase[],
  threshold: number,
  w: ActionQualityWeights = DEFAULT_ACTION_WEIGHTS
): OperatingPoint {
  let autoCount = 0;
  let escalateCount = 0;
  let mislabeled = 0;
  let wastedEscalations = 0;
  let savedEscalations = 0;
  let total = 0;
  let wouldBeWrong = 0;

  for (const c of cases) {
    const auto = c.correct !== null && c.confidence !== null && c.confidence >= threshold;
    if (auto) {
      autoCount++;
      if (!c.correct) {
        mislabeled++;
        wouldBeWrong++;
      }
    } else {
      escalateCount++;
      if (c.correct === null) continue; // 无法判定「本会怎样」，不计入拦截统计
      if (c.correct) wastedEscalations++;
      else {
        savedEscalations++;
        wouldBeWrong++;
      }
    }
  }
  total = cases.length;

  let utility = 0;
  for (const c of cases) utility += caseUtility(c, threshold, w);

  return {
    threshold,
    autoCount,
    escalateCount,
    autoCoverage: total > 0 ? autoCount / total : 0,
    autoPrecision: autoCount > 0 ? (autoCount - mislabeled) / autoCount : 0,
    mislabeled,
    wastedEscalations,
    savedEscalations,
    escalationRecall: wouldBeWrong > 0 ? savedEscalations / wouldBeWrong : 1,
    utilityPerCase: total > 0 ? utility / total : 0,
  };
}

/**
 * 扫描全部候选阈值（每个观测到的置信度 + 两个边界），取效用最大者。
 *
 * 只在观测点上取值，因为阈值落在两点之间时决策完全相同——扫描点越密
 * 越容易把噪声当成最优解。并列时取 autoCoverage 更大的那个：
 * 效用相同时自动化得更多，是更实用的解。
 */
export function selectOperatingPoint(
  cases: readonly ActionCase[],
  w: ActionQualityWeights = DEFAULT_ACTION_WEIGHTS
): OperatingPoint | null {
  if (cases.length === 0) return null;
  const observed = [...new Set(cases.map((c) => c.confidence).filter((x): x is number => x !== null))];
  const candidates = [0, ...observed.sort((a, b) => a - b), 1];
  let best: OperatingPoint | null = null;
  for (const t of candidates) {
    const p = evaluateThreshold(cases, t, w);
    if (
      best === null ||
      p.utilityPerCase > best.utilityPerCase + 1e-12 ||
      (Math.abs(p.utilityPerCase - best.utilityPerCase) <= 1e-12 && p.autoCoverage > best.autoCoverage)
    ) {
      best = p;
    }
  }
  return best;
}

/** 校准分桶：置信度 → 实际准确率（判断「自报把握」能不能当概率用） */
export interface CalibrationBin {
  lowerBound: number;
  upperBound: number;
  n: number;
  /** 桶内实际判对率 */
  accuracy: number;
  /** 桶内平均自报置信度 */
  meanConfidence: number;
}

export function calibrationBins(
  cases: readonly ActionCase[],
  binCount = 10
): CalibrationBin[] {
  const usable = cases.filter((c): c is ActionCase & { correct: boolean; confidence: number } =>
    c.correct !== null && c.confidence !== null
  );
  if (usable.length === 0 || binCount <= 0) return [];
  const bins: CalibrationBin[] = [];
  for (let i = 0; i < binCount; i++) {
    const lowerBound = i / binCount;
    const upperBound = (i + 1) / binCount;
    const inBin = usable.filter(
      (c) => c.confidence >= lowerBound && (i === binCount - 1 ? c.confidence <= upperBound : c.confidence < upperBound)
    );
    if (inBin.length === 0) continue;
    bins.push({
      lowerBound,
      upperBound,
      n: inBin.length,
      accuracy: inBin.filter((c) => c.correct).length / inBin.length,
      meanConfidence: inBin.reduce((a, c) => a + c.confidence, 0) / inBin.length,
    });
  }
  return bins;
}

/** 期望校准误差（ECE）：|桶内准确率 − 桶内平均置信度| 按样本量加权平均 */
export function expectedCalibrationError(bins: readonly CalibrationBin[]): number {
  const total = bins.reduce((a, b) => a + b.n, 0);
  if (total === 0) return 0;
  return bins.reduce((a, b) => a + (b.n / total) * Math.abs(b.accuracy - b.meanConfidence), 0);
}

export interface SensitivityRow {
  mislabel: number;
  wastedEscalation: number;
  breakEven: number;
  bestThreshold: number;
  utilityPerCase: number;
  autoCoverage: number;
}

/** 权重敏感性：不同代价假设下最优阈值与效用怎么变（防止结论依赖单一参数） */
export function weightSensitivity(
  cases: readonly ActionCase[],
  grid: Array<{ mislabel: number; wastedEscalation: number }> = [
    { mislabel: 1, wastedEscalation: 0.5 },
    { mislabel: 1, wastedEscalation: 0.2 },
    { mislabel: 2, wastedEscalation: 0.2 },
    { mislabel: 4, wastedEscalation: 0.2 },
    { mislabel: 4, wastedEscalation: 1 },
  ]
): SensitivityRow[] {
  return grid.map((g) => {
    const best = selectOperatingPoint(cases, g);
    return {
      ...g,
      breakEven: breakEvenProbability(g),
      bestThreshold: best?.threshold ?? Number.NaN,
      utilityPerCase: best?.utilityPerCase ?? 0,
      autoCoverage: best?.autoCoverage ?? 0,
    };
  });
}

export interface ActionQualityReport {
  weights: ActionQualityWeights;
  breakEven: number;
  best: OperatingPoint | null;
  /** 参照系：全自动（τ=0，等价于当前线上行为的准确率口径） */
  alwaysAuto: OperatingPoint;
  /** 参照系：全转人工（把本可判对的也推给人，效用为负） */
  alwaysEscalate: OperatingPoint;
  /** 最优 operating point 相对全自动的效用提升 */
  liftVsAlwaysAuto: number;
  /** 无法解析的 case 数（强制转人工，不参与阈值扫描） */
  unparsable: number;
  bins: CalibrationBin[];
  ece: number;
  sensitivity: SensitivityRow[];
}

export function actionQualityReport(
  cases: readonly ActionCase[],
  opts: { weights?: ActionQualityWeights; binCount?: number } = {}
): ActionQualityReport {
  const w = opts.weights ?? DEFAULT_ACTION_WEIGHTS;
  const best = selectOperatingPoint(cases, w);
  const alwaysAuto = evaluateThreshold(cases, 0, w);
  const alwaysEscalate = evaluateThreshold(cases, Number.POSITIVE_INFINITY, w);
  const bins = calibrationBins(cases, opts.binCount ?? 10);
  return {
    weights: w,
    breakEven: breakEvenProbability(w),
    best,
    alwaysAuto,
    alwaysEscalate,
    liftVsAlwaysAuto: (best?.utilityPerCase ?? 0) - alwaysAuto.utilityPerCase,
    unparsable: cases.filter((c) => c.correct === null).length,
    bins,
    ece: expectedCalibrationError(bins),
    sensitivity: weightSensitivity(cases, undefined),
  };
}

// ---------- 效用差的配对 bootstrap（与门禁第 2 条同一套口径） ----------

/** 逐条效用分数，按 caseId 对齐后给配对 bootstrap 用 */
export function utilityScores(
  cases: readonly ActionCase[],
  threshold: number,
  w: ActionQualityWeights = DEFAULT_ACTION_WEIGHTS
): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of cases) m.set(c.caseId, caseUtility(c, threshold, w));
  return m;
}

export interface PairedUtilityDelta {
  /** 平均每条 issue 的效用差（正 = 候选更好） */
  delta: number;
  lower: number;
  upper: number;
  matchedCases: number;
  coverage: number;
}

/**
 * 候选 vs 基线在效用上的配对 bootstrap 95% CI。
 *
 * 为什么配对：同一批 case 的难度是共同项，逐条做差消掉它——与
 * pairedDeltaCI95 同理，但作用在带权效用上。效用把「误标」放大 m 倍，
 * 因此同样的 case 翻转在效用口径下的效应量更大，这正是它能过门禁的原因。
 */
export function pairedUtilityDeltaCI(
  baseline: ReadonlyMap<string, number>,
  candidate: ReadonlyMap<string, number>,
  iterations = 1000,
  seed = 42
): PairedUtilityDelta | null {
  const diffs: number[] = [];
  for (const [caseId, value] of candidate) {
    const base = baseline.get(caseId);
    if (base === undefined) continue;
    diffs.push(value - base);
  }
  if (diffs.length === 0) return null;
  const n = diffs.length;
  const mean = diffs.reduce((a, b) => a + b, 0) / n;
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const stats: number[] = [];
  for (let it = 0; it < iterations; it++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += diffs[Math.floor(rand() * n)] ?? 0;
    stats.push(sum / n);
  }
  stats.sort((x, y) => x - y);
  return {
    delta: mean,
    lower: stats[Math.floor(iterations * 0.025)] ?? 0,
    upper: stats[Math.min(stats.length - 1, Math.floor(iterations * 0.975))] ?? 0,
    matchedCases: n,
    coverage: n / Math.min(baseline.size, candidate.size),
  };
}
