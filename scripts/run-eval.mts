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
import { Pool } from "pg";
import {
  DEFAULT_MODEL_CONFIG,
  resolveModel,
  createLlm,
  type Llm,
  type ModelConfig,
} from "../packages/llm/src/index";
import { handleIssueEvent, type IssueEvent } from "../apps/agent/src/index";
import { TRIAGE_PROMPT_VERSION } from "../apps/agent/src/triage";
import { createSimilarIssuesSearch } from "../apps/agent/src/similar-issues";
import { createBm25SimilarIssuesSearch } from "../apps/agent/src/similar-issues-bm25";
import { PgIssueDocsStore } from "../apps/agent/src/pg/issue-docs-pg";
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
// 数据集口径过滤：v1/v2 各有 assignment（v2 = v1 + expansion 100 入 dev，holdout 不变）；
// 禁止跨版本比较指标——门禁两侧必须同 ds 跑
const ASSIGNMENT_FILES: Record<string, string> = {
  v1: "datasets/review/v1-assignment.json",
  v2: "datasets/review/v2-assignment.json",
};

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
const PROMPT_VERSION = TRIAGE_PROMPT_VERSION; // 随 triage.ts 自动跟随（tp-1.2 → tp-1.3）
// 批内调用间隔：中转站频控（约 19s/条 连续 25 条即触发 9 分钟冷却），30s+ 可避开
const DELAY_MS = arg("delay-ms") ? Number(arg("delay-ms")) : 0;
// --retrieve：开启相似 issue 检索证据（<similar_issues> 注入，duplicate 缺口修复的对照实验）。
// 需要 DATABASE_URL（pgvector 向量库已回填）；检索自动排除 case 自身，防 gold 泄漏。
const RETRIEVE = argv.includes("--retrieve");
// --retrieve-bm25：轻量证据形态（BM25 零 API 成本 + 只注入编号+标题）。
// 动机：向量版证据注入成本 +145% 被门禁否决（668507d），百分比预算对 prompt 增量极敏感。
const RETRIEVE_BM25 = argv.includes("--retrieve-bm25");
// --skills-file + --skills-id：注入候选经验（<skills> 块，经验生效/对照实验同一通道）。
// 从 candidates.jsonl 按 id 取候选；tag 会决定报告文件名，注入内容摘要打印留痕。
const SKILLS_FILE = arg("skills-file");
const SKILLS_ID = arg("skills-id");
// --system-prompt-file + --prompt-label：候选提示词评测（tp-x.draft 过门禁前进不了代码默认值）
const SYSTEM_PROMPT_FILE = arg("system-prompt-file");
const PROMPT_LABEL = arg("prompt-label") ?? "tp-draft";

/** 全步成本合计（retrieve 开启后 steps 含检索 tool 步，不能只看 steps[0]） */
function totalCostOf(steps: Array<{ costAmount: number }>): number {
  return steps.reduce((s, x) => s + x.costAmount, 0);
}

// 免费中转通道分钟级抖动：零成本传输失败时退避重试整条 case
async function runWithRetry(
  event: IssueEvent,
  llm: Llm | undefined,
  deps: Parameters<typeof handleIssueEvent>[1] = {}
) {
  let res = await handleIssueEvent(event, { llm, ...deps });
  for (const delay of [30_000, 60_000, 120_000]) {
    if (!res.escalated || totalCostOf(res.steps) > 0) return res;
    const why = res.actions[0]?.kind === "escalate" ? (res.actions[0] as { reason: string }).reason : "";
    console.log(`    … 传输失败，${delay / 1000}s 后重试：${why.slice(0, 140)}`);
    await new Promise((r) => setTimeout(r, delay));
    res = await handleIssueEvent(event, { llm, ...deps });
  }
  return res;
}

// ---- 执行 ----
const cases = loadGoldenSet(DATA, { split: SPLIT }).slice(0, LIMIT);
// 口径过滤：数据集定稿后（tag dataset-vN），非本版本的扩充池记录必须排除（§7.1 纪律）。
// assignmentFile 缺失时（如 ds=v1-draft-n300 历史口径）不做过滤，由 tag 前缀区分。
const assignmentFile = ASSIGNMENT_FILES[DS];
if (assignmentFile && existsSync(resolve(ROOT, assignmentFile))) {
  const assignment = JSON.parse(readFileSync(resolve(ROOT, assignmentFile), "utf8")) as {
    v1?: { dev: string[]; holdout: string[] };
    v2?: { dev: string[]; holdout: string[] };
  };
  const member = assignment[DS as "v1" | "v2"];
  const ids = new Set([...member.dev, ...member.holdout]);
  const before = cases.length;
  const filtered = cases.filter((c) => ids.has(c.id));
  cases.length = 0;
  cases.push(...filtered.slice(0, LIMIT));
  console.log(`${DS} 口径过滤: ${before} → ${cases.length}（排除非 ${DS} 成员）`);
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

// 检索证据（--retrieve）：pgvector 向量库 + embed 查询；评测检索排除 case 自身
let pool: import("pg").Pool | null = null;
let evalDeps: Parameters<typeof handleIssueEvent>[1] = {};
if (SKILLS_FILE) {
  const rows = readFileSync(resolve(ROOT, SKILLS_FILE), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { id: string; type: string; pattern: string; content: string; status: string });
  const cand = SKILLS_ID ? rows.find((r) => r.id === SKILLS_ID) : rows[0];
  if (!cand) {
    console.error(`skills-file 中找不到候选 ${SKILLS_ID ?? "(第一条)"}`);
    process.exit(1);
  }
  evalDeps = { ...evalDeps, skills: [`[${cand.type}] ${cand.pattern}\n${cand.content}`] };
  console.log(`技能注入: ${cand.id}（${cand.type}，${cand.content.length} 字，status=${cand.status}）`);
  console.log(`  pattern: ${cand.pattern}`);
}
if (SYSTEM_PROMPT_FILE) {
  const text = readFileSync(resolve(ROOT, SYSTEM_PROMPT_FILE), "utf8");
  evalDeps = { ...evalDeps, systemPrompt: text, promptVersionLabel: PROMPT_LABEL };
  console.log(`系统提示词覆盖: ${SYSTEM_PROMPT_FILE}（${text.length} 字，label=${PROMPT_LABEL}；默认 tp-1.3 为 ${TRIAGE_PROMPT_VERSION === "tp-1.3" ? "同版" : TRIAGE_PROMPT_VERSION}）`);
}
if (RETRIEVE) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("--retrieve 需要 DATABASE_URL（向量库未就绪）");
    process.exit(1);
  }
  pool = new Pool({
    connectionString,
    options: "-c search_path=evokeeper,public",
    max: 2,
  });
  const store = new PgIssueDocsStore(pool);
  const docs = await store.count();
  if (docs === 0) {
    console.error("向量库为空：先跑 scripts/embed-backfill.mts 回填");
    process.exit(1);
  }
  const similarSearch = createSimilarIssuesSearch({ llm: llm ?? createLlm(), store });
  evalDeps = { ...evalDeps, similarSearch };
  console.log(`检索证据: 开启（向量库 ${docs} 条，top-5，排除自身）`);
}
if (RETRIEVE_BM25) {
  const similarSearch = createBm25SimilarIssuesSearch({ corpusPath: DATA });
  evalDeps = { ...evalDeps, similarSearch };
  console.log(`检索证据: BM25 轻量模式（语料 ${DATA}，编号+标题 top-3，零 API 成本）`);
}
process.on("exit", () => void pool?.end());
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

let called = 0;
for (const c of cases) {
  const resumed = resumedCases.get(c.id);
  if (resumed) {
    // 断点恢复：预测来自轨迹库，gold 从 golden set 补齐后计入结果
    results.push({ ...resumed, goldMain: c.goldMain, goldNeedsMoreInfo: c.goldNeedsMoreInfo });
    continue;
  }
  if (DELAY_MS > 0 && called > 0) {
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }
  called++;
  const event: IssueEvent = {
    repo: c.repo,
    issueNumber: c.issueNumber,
    title: c.title,
    body: c.bodyExcerpt,
  };
  const res = await runWithRetry(event, llm, evalDeps);
  const stepCost = totalCostOf(res.steps);
  const stepDuration = res.steps.reduce((s, x) => s + x.durationMs, 0);
  totalCost += stepCost;
  results.push({
    caseId: c.id,
    goldMain: c.goldMain,
    predMain: res.triage ? mainLabelOf(res.triage.labels) : null,
    goldNeedsMoreInfo: c.goldNeedsMoreInfo,
    predNeedsMoreInfo: res.triage?.labels.includes("needs-more-info") ?? false,
    costAmount: stepCost,
    durationMs: stepDuration,
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
    `${mark} ${c.id} gold=${c.goldMain.padEnd(8)} pred=${(results[results.length - 1]?.predMain ?? "FAIL").padEnd(8)} ¥${stepCost.toFixed(4)}`
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
