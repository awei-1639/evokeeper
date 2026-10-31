/**
 * 门禁口径回溯审计（design.md §7.2 v1.19）
 *
 * 背景：门禁第 2 条曾用「候选 run 的绝对准确率 CI」判 `lower > 0`——准确率 0.6+ 时恒真，
 * 该条等于没有判定。修正为「Δ（候选−基线）配对 bootstrap CI 下界 > 0」后，
 * 本脚本把历史 run 全部按新口径重算一遍，回答两个问题：
 *   1. 已做出的 REJECTED 判定是否因此松动（审计结论是否仍站得住）；
 *   2. 那些「差一点点」的候选，在统计上到底是真增益还是噪声。
 *
 * 用法：pnpm exec tsx scripts/gate-recheck.mts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pairedDeltaCI95, type EvalRun } from "../packages/eval/src/index";

interface RunFile {
  run: EvalRun;
}

const DIR = "datasets/eval";

function load(file: string): EvalRun {
  return (JSON.parse(readFileSync(join(DIR, file), "utf8")) as RunFile).run;
}

/** 基线 → 候选 的对照关系（历史实验的实际配对） */
const PAIRS: Array<{ baseline: string; candidate: string; label: string }> = [
  {
    label: "skill 经验（question 泛化）",
    baseline: "run-skill-gate-base-dev-deepseek-v4-flash-mc-1.0-v1.json",
    candidate: "run-skill-gate-cand1-dev-deepseek-v4-flash-mc-1.0-v1.json",
  },
  {
    label: "检索证据注入（<similar_issues>）",
    baseline: "run-skill-gate-base-dev-deepseek-v4-flash-mc-1.0-v1.json",
    candidate: "run-gate-retr-cand-dev-deepseek-v4-flash-mc-1.0-v1.json",
  },
  {
    label: "轻量证据（BM25 编号+标题）",
    baseline: "run-skill-gate-base-dev-deepseek-v4-flash-mc-1.0-v1.json",
    candidate: "run-gate-bm25-cand-dev-deepseek-v4-flash-mc-1.0-v1.json",
  },
  {
    label: "tp-1.4 精简（第 1 轮）",
    baseline: "run-skill-gate-base-dev-deepseek-v4-flash-mc-1.0-v1.json",
    candidate: "run-gate-tp14-cand-dev-deepseek-v4-flash-mc-1.0-v1.json",
  },
  {
    label: "tp-1.4 精简（第 2 轮）",
    baseline: "run-skill-gate-base-dev-deepseek-v4-flash-mc-1.0-v1.json",
    candidate: "run-gate-tp14d2-cand-dev-deepseek-v4-flash-mc-1.0-v1.json",
  },
  {
    label: "tp-1.4 精简 · v2 数据集",
    baseline: "run-v2-base-dev-deepseek-v4-flash-mc-1.0-v2.json",
    candidate: "run-v2-tp14d2-dev-deepseek-v4-flash-mc-1.0-v2.json",
  },
];

function pct(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}pt`;
}

console.log(`\n门禁第 2 条回溯审计（Δ 配对 bootstrap，1000 次重采样）`);
console.log(`目录 ${DIR}，共 ${readdirSync(DIR).filter((f) => f.endsWith(".json")).length} 个 run 文件\n`);

for (const p of PAIRS) {
  let base: EvalRun;
  let cand: EvalRun;
  try {
    base = load(p.baseline);
    cand = load(p.candidate);
  } catch {
    console.log(`✗ ${p.label}：文件缺失，跳过`);
    continue;
  }
  if (base.datasetVersion !== cand.datasetVersion) {
    console.log(`✗ ${p.label}：datasetVersion 不一致（${base.datasetVersion} vs ${cand.datasetVersion}），拒绝比较`);
    continue;
  }
  const paired = pairedDeltaCI95(base, cand);
  const accDelta = (cand.metrics.triageAccuracy - base.metrics.triageAccuracy) * 100;
  if (paired === null) {
    console.log(`✗ ${p.label}：无对齐 case`);
    continue;
  }
  const significant = paired.lowerPt > 0;
  const oldVerdict = (cand.ci95?.lower ?? -1) > 0 ? "PASS(恒真)" : "FAIL";
  const newVerdict = significant ? "PASS" : "FAIL";
  console.log(`【${p.label}】`);
  console.log(
    `  acc ${(base.metrics.triageAccuracy * 100).toFixed(1)}% → ${(cand.metrics.triageAccuracy * 100).toFixed(1)}%（Δ ${pct(accDelta)}）  n=${paired.matchedCases}  覆盖率 ${(paired.coverage * 100).toFixed(0)}%`
  );
  console.log(
    `  Δ 配对 CI95 = [${paired.lowerPt.toFixed(2)}, ${paired.upperPt.toFixed(2)}]pt  → ${significant ? "统计显著" : "不可判别（CI 跨 0）"}`
  );
  console.log(`  第 2 条判定：旧口径 ${oldVerdict} → 新口径 ${newVerdict}`);
  console.log("");
}
