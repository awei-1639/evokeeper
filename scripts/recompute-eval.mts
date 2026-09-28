/**
 * EvalRun 口径重算（§7.1 纪律）—— 当评测样本范围与数据集版本口径不一致时，
 * 从 perCaseDetail 过滤重算指标，无需重跑 LLM（预测结果不变，只改统计口径）。
 *
 * 典型场景：datasetVersion=v1 的 dev 基线误含扩充池记录（260 条），
 * 应只统计 v1-assignment.v1.dev 的 160 条。
 *
 * 用法：pnpm tsx scripts/recompute-eval.mts --run=<file> [--assignment=datasets/review/v1-assignment.json]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapCI95, makeEvalRun, type CaseResult } from "../packages/eval/src/index";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const argv = process.argv.slice(2);
const arg = (name: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

const runFile = resolve(ROOT, arg("run") ?? "");
const assignmentFile = arg("assignment")
  ? resolve(ROOT, arg("assignment") ?? "")
  : resolve(ROOT, "datasets/review/v1-assignment.json");

const raw = JSON.parse(readFileSync(runFile, "utf8")) as {
  run: { id: string; split: string; datasetVersion: string; modelConfig: unknown };
  perCaseDetail: Array<Record<string, unknown>>;
};
const assignment = JSON.parse(readFileSync(assignmentFile, "utf8")) as {
  v1: { dev: string[]; holdout: string[] };
};

const run = raw.run;
const v1Ids = new Set(run.split === "holdout" ? assignment.v1.holdout : assignment.v1.dev);
const detail = raw.perCaseDetail.filter((c) => v1Ids.has(String(c["caseId"])));
console.log(`perCase 过滤: ${raw.perCaseDetail.length} → ${detail.length}（v1 ${run.split} 口径）`);

const cases: CaseResult[] = detail.map((c) => ({
  caseId: String(c["caseId"]),
  goldMain: c["goldMain"] as CaseResult["goldMain"],
  predMain: (c["predMain"] as CaseResult["predMain"]) ?? null,
  goldNeedsMoreInfo: Boolean(c["goldNeedsMoreInfo"]),
  predNeedsMoreInfo: Boolean(c["predNeedsMoreInfo"]),
  costAmount: Number(c["costAmount"] ?? 0),
  durationMs: Number(c["durationMs"] ?? 0),
}));

const corrected = makeEvalRun({
  id: run.id,
  candidateId: null,
  baselineRunId: null,
  datasetVersion: run.datasetVersion,
  split: run.split as "dev" | "holdout",
  modelConfig: run.modelConfig as ConstructorParameters<typeof makeEvalRun>[0]["modelConfig"],
  cases,
});
const payload = { ...raw, run: corrected, perCaseDetail: detail, note: "口径重算：仅统计 v1-assignment.v1 内的样本（recompute-eval）" };
writeFileSync(runFile, JSON.stringify(payload, null, 2), "utf8");
console.log(
  `已重算并写回 ${runFile}\naccuracy: ${(corrected.metrics.triageAccuracy * 100).toFixed(1)}% | 宏F1: ${corrected.metrics.triageMacroF1.toFixed(3)} | CI95: [${((corrected.ci95?.lower ?? 0) * 100).toFixed(2)}, ${((corrected.ci95?.upper ?? 0) * 100).toFixed(2)}]pt`
);
