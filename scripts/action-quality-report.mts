/**
 * 动作质量报告（design.md §7.4）—— 从 EvalRun 文件离线复算，不调用模型
 *
 * 用法：
 *   pnpm exec tsx scripts/action-quality-report.mts --run=datasets/eval/run-aq-base-dev-....json
 *   ... --vs=datasets/eval/run-<candidate>.json     # 加配对效用差 bootstrap
 *
 * 为什么单独成脚本：动作质量口径要能对**历史 run 复算**（只要 run 里存了 confidence），
 * 否则每次换权重假设都得重跑一遍模型，等于把「换个代价假设」的成本抬到 ¥1 量级，
 * 没人会去质疑默认参数。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  actionQualityReport,
  breakEvenProbability,
  evaluateThreshold,
  pairedUtilityDeltaCI,
  selectOperatingPoint,
  utilityScores,
  weightSensitivity,
  type ActionCase,
} from "../packages/eval/src/action-quality";

const ROOT = resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const arg = (n: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=");

const RUN = arg("run");
if (!RUN) {
  console.error("用法：--run=<EvalRun json> [--vs=<对照 EvalRun json>]");
  process.exit(1);
}

interface RunFile {
  run?: { datasetVersion?: string; modelConfig?: { version?: string } };
  perCaseDetail?: Array<{
    caseId: string;
    goldMain: string;
    predMain: string | null;
    confidence?: number | null;
  }>;
}

function loadCases(path: string): { cases: ActionCase[]; label: string; missing: number } {
  const file = JSON.parse(readFileSync(resolve(ROOT, path), "utf8")) as RunFile;
  const rows = file.perCaseDetail ?? [];
  if (rows.length === 0) throw new Error(`${path} 无 perCaseDetail`);
  let missing = 0;
  const cases: ActionCase[] = [];
  for (const r of rows) {
    const conf = r.confidence ?? null;
    // 置信度缺失且已有预测 → 无法判定该 case 的决策，排除（否则会被误当成"转人工"）
    if (conf === null && r.predMain !== null) {
      missing++;
      continue;
    }
    cases.push({
      caseId: r.caseId,
      correct: r.predMain === null ? null : r.predMain === r.goldMain,
      confidence: conf,
    });
  }
  const label = `${file.run?.datasetVersion ?? "?"}/${file.run?.modelConfig?.version ?? "?"}`;
  return { cases, label, missing };
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const f3 = (x: number): string => x.toFixed(3);

const base = loadCases(RUN);
console.log(`== 动作质量报告 == ${RUN}`);
console.log(`数据 ${base.label} | case ${base.cases.length}${base.missing > 0 ? `（置信度缺失排除 ${base.missing}）` : ""}`);

// 护栏：可用样本不足时拒绝出报告。
// 历史 run（2026-10-31 之前）根本没采集 confidence，此时所有指标都会算成 0，
// 看起来像「模型什么都没做」——这是假结论，比报错更危险（同 sampling-probe 的教训）。
const MIN_USABLE_CASES = 30;
if (base.cases.length < MIN_USABLE_CASES) {
  console.error(
    `\n不可用：可用于动作质量口径的 case 仅 ${base.cases.length} 条（下限 ${MIN_USABLE_CASES}），` +
      `本 run 未采集 confidence。请用带置信度采集的 tag 重跑 eval（run-eval 自 2026-10-31 起已记录）。`
  );
  process.exit(2);
}

const r = actionQualityReport(base.cases);
console.log(`\n盈亏平衡 p* = ${f3(r.breakEven)}（m=${r.weights.mislabel}, w=${r.weights.wastedEscalation}）`);
console.log(`校准 ECE = ${f3(r.ece)}${r.ece > 0.15 ? "  ⚠️ > 0.15：置信度不能当概率用，禁止宣称 operating point 收益" : ""}`);
console.log(
  `全自动  : 效用 ${f3(r.alwaysAuto.utilityPerCase)}/条  误标 ${r.alwaysAuto.mislabeled}  自动精确率 ${pct(r.alwaysAuto.autoPrecision)}`
);
console.log(
  `全转人工: 效用 ${f3(r.alwaysEscalate.utilityPerCase)}/条  白看 ${r.alwaysEscalate.wastedEscalations}`
);
if (r.best)
  console.log(
    `最优    : τ=${f3(r.best.threshold)}  自动标注 ${pct(r.best.autoCoverage)}  自动精确率 ${pct(r.best.autoPrecision)}  拦截召回 ${pct(r.best.escalationRecall)}  效用 ${f3(r.best.utilityPerCase)}/条（vs 全自动 ${r.liftVsAlwaysAuto >= 0 ? "+" : ""}${f3(r.liftVsAlwaysAuto)}）`
  );
// 线上实际阈值 0.5 的现状，供对照
const live = evaluateThreshold(base.cases, 0.5, r.weights);
console.log(
  `线上 τ=0.50（CONFIDENCE_THRESHOLD）: 效用 ${f3(live.utilityPerCase)}/条  自动标注 ${pct(live.autoCoverage)}  误标 ${live.mislabeled}  白看 ${live.wastedEscalations}`
);

console.log(`\n-- 校准曲线 --`);
for (const b of r.bins)
  console.log(
    `  [${b.lowerBound.toFixed(1)},${b.upperBound.toFixed(1)})  n=${String(b.n).padStart(3)}  实际 ${pct(b.accuracy).padStart(6)}  自报 ${pct(b.meanConfidence).padStart(6)}  差 ${((b.accuracy - b.meanConfidence) * 100).toFixed(1)}pt`
  );

console.log(`\n-- 权重敏感性 --`);
const sens = weightSensitivity(base.cases, [
  { mislabel: 1, wastedEscalation: 0.5 },
  { mislabel: 1, wastedEscalation: 0.2 },
  { mislabel: 2, wastedEscalation: 0.2 },
  { mislabel: 2, wastedEscalation: 0.5 },
  { mislabel: 4, wastedEscalation: 0.2 },
  { mislabel: 4, wastedEscalation: 1 },
]);
console.log(`  m    w     p*    最优τ  自动覆盖  效用/条`);
for (const s of sens)
  console.log(
    `  ${String(s.mislabel).padEnd(4)} ${String(s.wastedEscalation).padEnd(4)} ${f3(s.breakEven)}  ${f3(s.bestThreshold).padEnd(6)} ${pct(s.autoCoverage).padStart(7)}  ${f3(s.utilityPerCase)}`
  );

const VS = arg("vs");
if (VS) {
  const cand = loadCases(VS);
  const baseBest = selectOperatingPoint(base.cases, r.weights);
  const candBest = selectOperatingPoint(cand.cases, r.weights);
  const baseScores = utilityScores(base.cases, baseBest?.threshold ?? 0, r.weights);
  const candScores = utilityScores(cand.cases, candBest?.threshold ?? 0, r.weights);
  const d = pairedUtilityDeltaCI(baseScores, candScores);
  console.log(`\n-- 配对效用差（候选 ${cand.label} − 基线）--`);
  if (!d) {
    console.log("  无法对齐（无共同 caseId）→ 判 fail，不得默认通过");
    process.exit(0);
  }
  console.log(
    `  Δ = ${d.delta >= 0 ? "+" : ""}${f3(d.delta)}/条  CI95 [${f3(d.lower)}, ${f3(d.upper)}]  对齐 ${d.matchedCases} 条（覆盖 ${pct(d.coverage)}）`
  );
  console.log(
    d.lower > 0
      ? `  → CI 下界 > 0：效用在统计上可判别地变好（p*=${f3(breakEvenProbability(r.weights))}）`
      : `  → CI 跨 0：不可判别，禁止据此发布`
  );
}
