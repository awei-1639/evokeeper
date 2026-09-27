/**
 * 评测 runner（W6）—— 把 golden set 真实跑一遍，产出 EvalRun JSON（门禁输入）
 *
 * 与 pilot 脚本的区别：产出结构化 EvalRun（含 modelConfig 快照 / ci95 / perCase），
 * 供 `eval:gate` 消费；holdout 评测为只读（本脚本不改任何数据）。
 *
 * 用法：
 *   pnpm eval:run -- --tag=baseline --split=dev --ds=v1-draft-n300
 *   pnpm eval:run -- --tag=cand-1 --split=dev --ds=v1-draft-n300 --limit=50
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODEL_CONFIG, resolveModel, type ModelConfig } from "../packages/llm/src/index";
import { handleIssueEvent } from "../apps/agent/src/index";
import {
  bootstrapCI95,
  loadGoldenSet,
  mainLabelOf,
  makeEvalRun,
  needsMoreInfoReport,
  type CaseResult,
} from "../packages/eval/src/index";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DATA = resolve(ROOT, "datasets/drafts/alibaba_nacos.jsonl");

const envText = readFileSync(resolve(ROOT, ".env.local"), "utf8");
for (const line of envText.split("\n")) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
if (!process.env.DEEPSEEK_API_KEY) {
  console.error("缺少 DEEPSEEK_API_KEY");
  process.exit(1);
}

// ---- 参数 ----
const argv = process.argv.slice(2);
const arg = (name: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const TAG = arg("tag") ?? "baseline";
const SPLIT = (arg("split") as "dev" | "holdout") ?? "dev";
const DS = arg("ds") ?? "v1-draft-n300";
const LIMIT = arg("limit") ? Number(arg("limit")) : Infinity;
const MODEL = arg("model");
const MODEL_OVERRIDE = MODEL
  ? { ...DEFAULT_MODEL_CONFIG, routing: { ...DEFAULT_MODEL_CONFIG.routing, triage: MODEL } }
  : DEFAULT_MODEL_CONFIG;
const PROMPT_VERSION = "tp-1.2";

// ---- 执行 ----
const cases = loadGoldenSet(DATA, { split: SPLIT }).slice(0, LIMIT);
if (cases.length === 0) {
  console.error(`golden set（split=${SPLIT}）无已定稿记录`);
  process.exit(1);
}
const model = MODEL ?? resolveModel("triage", MODEL_OVERRIDE as ModelConfig);
console.log(`== eval:run == tag=${TAG} split=${SPLIT} ds=${DS} 模型=${model} 样本=${cases.length}`);

const results: CaseResult[] = [];
let totalCost = 0;
for (const c of cases) {
  const res = await handleIssueEvent({
    repo: c.repo,
    issueNumber: c.issueNumber,
    title: c.title,
    body: c.bodyExcerpt,
  });
  const step = res.steps[0];
  totalCost += step?.costAmount ?? 0;
  results.push({
    caseId: c.id,
    goldMain: c.goldMain,
    predMain: res.triage ? mainLabelOf(res.triage.labels) : null,
    goldNeedsMoreInfo: c.goldNeedsMoreInfo,
    predNeedsMoreInfo: res.triage?.labels.includes("needs-more-info") ?? false,
    costAmount: step?.costAmount ?? 0,
    durationMs: step?.durationMs ?? 0,
  });
  const mark = results[results.length - 1]?.predMain === c.goldMain ? "✓" : "✗";
  console.log(
    `${mark} ${c.id} gold=${c.goldMain.padEnd(8)} pred=${(results[results.length - 1]?.predMain ?? "FAIL").padEnd(8)} ¥${(step?.costAmount ?? 0).toFixed(4)}`
  );
}

const run = makeEvalRun({
  id: `run-${TAG}-${SPLIT}-${DS}`,
  candidateId: TAG.startsWith("cand") ? TAG : null,
  baselineRunId: null,
  datasetVersion: DS,
  split: SPLIT,
  modelConfig: MODEL_OVERRIDE as ModelConfig,
  cases: results,
});
const nmi = needsMoreInfoReport(results);

console.log("");
console.log("== EvalRun 汇总 ==");
console.log(`accuracy: ${(run.metrics.triageAccuracy * 100).toFixed(1)}% | 宏F1: ${run.metrics.triageMacroF1.toFixed(3)}`);
console.log(`nmi: 命中 ${nmi.hit}/${nmi.goldCount} | 误报 ${nmi.falsePositives}`);
console.log(`CI95: [${((run.ci95?.lower ?? 0) * 100).toFixed(2)}pt, ${((run.ci95?.upper ?? 0) * 100).toFixed(2)}pt]`);
console.log(`成本: ¥${totalCost.toFixed(4)} | p50 ${run.metrics.p50LatencyMs}ms / p95 ${run.metrics.p95LatencyMs}ms`);

// ---- 落盘（防覆盖）----
const outDir = resolve(ROOT, "datasets/eval");
mkdirSync(outDir, { recursive: true });
const outFile = resolve(outDir, `run-${TAG}-${SPLIT}-${model}-${(MODEL_OVERRIDE as ModelConfig).version}-${DS}.json`);
if (existsSync(outFile) && !argv.includes("--force")) {
  console.error(`报告已存在，拒绝覆盖（加 --force 强制）：${outFile}`);
  process.exit(1);
}
writeFileSync(outFile, JSON.stringify({ run, nmi, perCaseDetail: results }, null, 2), "utf8");
console.log(`\nEvalRun 已写入: ${outFile}`);
