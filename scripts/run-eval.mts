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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MODEL_CONFIG,
  resolveModel,
  createLlm,
  type Llm,
  type ModelConfig,
} from "../packages/llm/src/index";
import { handleIssueEvent, type IssueEvent } from "../apps/agent/src/index";
import { buildTrace, JsonlTraceStore } from "../apps/agent/src/trace-store";
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
  const m = /^([A-Z_]+)\s*=\s*([^#]*?)\s*(?:#.*)?$/.exec(line.trim());
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

// 免费中转通道分钟级抖动：零成本传输失败时退避重试整条 case
async function runWithRetry(event: IssueEvent, llm: Llm | undefined) {
  let res = await handleIssueEvent(event, { llm });
  for (const delay of [30_000, 60_000, 120_000]) {
    if (!res.escalated || (res.steps[0]?.costAmount ?? 0) > 0) return res;
    console.log(`    … 传输失败，${delay / 1000}s 后重试`);
    await new Promise((r) => setTimeout(r, delay));
    res = await handleIssueEvent(event, { llm });
  }
  return res;
}

// ---- 执行 ----
const cases = loadGoldenSet(DATA, { split: SPLIT }).slice(0, LIMIT);
// v1 口径过滤：数据集定稿后（tag dataset-v1），扩充池 100 条不属于 v1，
// 评测 dev/holdout 时必须按 v1-assignment 过滤，否则指标混入非 v1 样本（§7.1 纪律）
if (DS === "v1" && existsSync(resolve(ROOT, "datasets/review/v1-assignment.json"))) {
  const assignment = JSON.parse(
    readFileSync(resolve(ROOT, "datasets/review/v1-assignment.json"), "utf8")
  ) as { v1: { dev: string[]; holdout: string[] } };
  const v1Ids = new Set([...assignment.v1.dev, ...assignment.v1.holdout]);
  const before = cases.length;
  const filtered = cases.filter((c) => v1Ids.has(c.id));
  cases.length = 0;
  cases.push(...filtered.slice(0, LIMIT));
  console.log(`v1 口径过滤: ${before} → ${cases.length}（排除扩充池记录）`);
}
if (cases.length === 0) {
  console.error(`golden set（split=${SPLIT}）无已定稿记录`);
  process.exit(1);
}
const model = MODEL ?? resolveModel("triage", MODEL_OVERRIDE as ModelConfig);
console.log(`== eval:run == tag=${TAG} split=${SPLIT} ds=${DS} 模型=${model} 样本=${cases.length}`);

const llm: Llm | undefined =
  JSON.stringify(MODEL_OVERRIDE) !== JSON.stringify(DEFAULT_MODEL_CONFIG)
    ? createLlm({ config: MODEL_OVERRIDE })
    : undefined;
const results: CaseResult[] = [];
let totalCost = 0;
// 轨迹持久化（默认开）：评测轨迹是影子回放与整理管线的离线输入
const SAVE_TRACES = !argv.includes("--no-traces");
if (SAVE_TRACES) mkdirSync(resolve(ROOT, "datasets/traces"), { recursive: true });
const traceStore = SAVE_TRACES
  ? new JsonlTraceStore(resolve(ROOT, "datasets/traces/traces.jsonl"))
  : null;
let savedTraces = 0;
let duplicateTraces = 0;

// 断点续跑：从轨迹库恢复已完成 case 的预测（通道中断不丢进度）
const resumedCases = new Map<string, CaseResult>();
if (traceStore) {
  for (const t of await traceStore.all()) {
    const m = new RegExp(`^trace-eval-${TAG}-${DS}-(.+)$`).exec(t.id);
    if (!m || !m[1]) continue;
    if (t.totalCost <= 0) continue; // 零成本 escalate = 传输失败垃圾，不作为断点
    const caseId = m[1];
    const labels = t.finalActions.flatMap((a) => (a.kind === "addLabels" ? a.labels : []));
    resumedCases.set(caseId, {
      caseId,
      goldMain: "invalid", // 占位：恢复行不参与指标（下方按需重算 gold）
      predMain: labels.length > 0 ? mainLabelOf(labels) : null,
      goldNeedsMoreInfo: false,
      predNeedsMoreInfo: false,
      costAmount: t.totalCost,
      durationMs: 0,
    });
  }
  if (resumedCases.size > 0) {
    console.log(`断点续跑：轨迹库中已有 ${resumedCases.size} 条本 run 的 case，跳过重跑`);
  }
}

for (const c of cases) {
  const resumed = resumedCases.get(c.id);
  if (resumed) {
    // 断点恢复：预测来自轨迹库，gold 从 golden set 补齐后计入结果
    results.push({ ...resumed, goldMain: c.goldMain, goldNeedsMoreInfo: c.goldNeedsMoreInfo });
    continue;
  }
  const event: IssueEvent = {
    repo: c.repo,
    issueNumber: c.issueNumber,
    title: c.title,
    body: c.bodyExcerpt,
  };
  const res = await runWithRetry(event, llm);
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
  if (traceStore) {
    // 确定性 id：同 tag/dataset/case 重跑不重复落库（幂等，R3）
    const id = `trace-eval-${TAG}-${DS}-${c.id}`;
    try {
      await traceStore.append(buildTrace(event, res, { id }));
      savedTraces++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("重复")) {
        duplicateTraces++;
      } else {
        console.error(`  轨迹落库失败 ${c.id}: ${msg}`);
      }
    }
  }
  const mark = results[results.length - 1]?.predMain === c.goldMain ? "✓" : "✗";
  console.log(
    `${mark} ${c.id} gold=${c.goldMain.padEnd(8)} pred=${(results[results.length - 1]?.predMain ?? "FAIL").padEnd(8)} ¥${(step?.costAmount ?? 0).toFixed(4)}`
  );
}

// 质量门：解析失败率 >20% 说明通道大面积不可用，报告不可信——不落盘，
// 断点（有效轨迹）已保留，通道恢复后重跑补缺口
const failCount = results.filter((r) => r.predMain === null).length;
const failRate = results.length > 0 ? failCount / results.length : 0;
if (failRate > 0.2) {
  console.error(
    `质量门拦截：解析失败 ${failCount}/${results.length}（${(failRate * 100).toFixed(0)}% > 20%）——通道大面积不可用，本轮报告不落盘。稍后重跑（断点已保留）。`
  );
  process.exit(1);
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
if (traceStore) {
  console.log(`轨迹落库: 新增 ${savedTraces} 条${duplicateTraces > 0 ? `（重复跳过 ${duplicateTraces}）` : ""}`);
}

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
