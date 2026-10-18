/**
 * 分诊 pilot 评测 —— 锁定 triage 档模型选型（design.md §12 待决问题 1 / §9.1 原则 4）
 *
 * 评测口径（design.md §7.1）：
 * - 主标签严格比对：预测主性质（bug/feature/question/duplicate，无则 invalid）=== gold 主性质
 * - needs-more-info 不参与主判定，单独报告命中与误报
 * - 模型输出解析失败 = 判错（这就是门禁要抓的失败，不豁免）
 * - 防泄漏铁律：buildTriageMessages 默认不喂 raw_labels（design.md §3.1）
 *
 * 用法：
 *   pnpm pilot:triage                 # 前 50 条，默认模型（deepseek-v4-flash）
 *   pnpm pilot:triage -- --limit=50 --model deepseek-v4-pro   # 对比其他模型
 *   pnpm pilot:triage -- --limit=300 --tag=baseline --ds=v1-draft-300  # 基线跑批（独立报告文件）
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { handleIssueEvent, type IssueEvent } from "../apps/agent/src/index";
import { DEFAULT_MODEL_CONFIG, resolveModel } from "../packages/llm/src/config";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DATA = resolve(ROOT, "datasets/drafts/alibaba_nacos.jsonl");

// ---- 加载 .env.local（DEEPSEEK_API_KEY 等）----
const envText = readFileSync(resolve(ROOT, ".env.local"), "utf8");
for (const line of envText.split("\n")) {
  const m = /^([A-Z_]+)\s*=\s*([^#]*?)\s*(?:#.*)?$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
if (!process.env.DEEPSEEK_API_KEY) {
  console.error("缺少 DEEPSEEK_API_KEY：请写入 .env.local");
  process.exit(1);
}

// ---- 参数 ----
const argv = process.argv.slice(2);
const limitArg = argv.find((a) => a.startsWith("--limit="));
const modelArg = argv.find((a) => a.startsWith("--model="));
const tagArg = argv.find((a) => a.startsWith("--tag="));
const dsArg = argv.find((a) => a.startsWith("--ds="));
const LIMIT = limitArg ? Number(limitArg.split("=")[1]) : 50;
const MODEL = modelArg ? modelArg.split("=")[1] : undefined;
const TAG = tagArg ? tagArg.split("=")[1] : "pilot"; // 报告文件名前缀，区分 pilot/baseline 等用途
const DATASET_VERSION = dsArg ? dsArg.split("=")[1] : null; // 数据集版本快照标识，禁止跨版本比较
const PROMPT_VERSION = "tp-1.3"; // prompt 升级时同步改这里，报告文件名随之区分

// --model 覆盖路由（此前该旗标只改了报告文件名、从未传入 LLM——已修复）
import { DEFAULT_MODEL_CONFIG, resolveModel, type ModelConfig } from "../packages/llm/src/index";
import { createLlm, type Llm } from "../packages/llm/src/index";
const MODEL_OVERRIDE: ModelConfig | undefined = MODEL
  ? { ...DEFAULT_MODEL_CONFIG, routing: { ...DEFAULT_MODEL_CONFIG.routing, triage: MODEL } }
  : undefined;
const llm: Llm | undefined = MODEL_OVERRIDE ? createLlm({ config: MODEL_OVERRIDE }) : undefined;

const MAIN = ["bug", "feature", "question", "duplicate"] as const;
type Main = (typeof MAIN)[number] | "invalid";

function mainOf(labels: string[] | undefined): Main {
  const m = (labels ?? []).find((l) => (MAIN as readonly string[]).includes(l));
  return (m as Main) ?? "invalid";
}

interface DraftRow {
  repo: string;
  issue_number: number;
  title: string;
  body_excerpt: string;
  raw_labels: string[];
  labels_gold: string[];
  difficulty: string;
  url: string;
}

const allRows: DraftRow[] = readFileSync(DATA, "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));

const rows = allRows.slice(0, LIMIT).filter((r) => (r.labels_gold ?? []).length > 0);
console.log("== EvoKeeper 分诊 pilot ==");
console.log(
  `模型: ${MODEL ?? resolveModel("triage")} | prompt: ${PROMPT_VERSION} | 样本: ${rows.length}`
);
console.log("");

interface PerCase {
  issue_number: number;
  gold: string;
  pred: string | null;
  correct: boolean;
  nmiGold: boolean;
  nmiPred: boolean;
  confidence: number | null;
  escalated: boolean;
  costAmount: number;
  durationMs: number;
  difficulty: string;
  rationale: string | null;
}

const perCase: PerCase[] = [];
let totalCost = 0;

// 断点续跑：逐 case 落盘（同时是进度观测文件），重启后跳过已完成并恢复统计
const PARTIAL_FILE = resolve(
  ROOT,
  `datasets/pilot/.pilot-partial-${(MODEL ?? resolveModel("triage")).replace(/[^\w.-]/g, "_")}-${PROMPT_VERSION}.jsonl`
);
const partialRows: PerCase[] = existsSync(PARTIAL_FILE)
  ? readFileSync(PARTIAL_FILE, "utf8")
      .trim()
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as PerCase)
  : [];
const seen = new Set<number>();
const deduped = partialRows.filter((r) => (seen.has(r.issue_number) ? false : (seen.add(r.issue_number), true)));
perCase.length = 0;
perCase.push(...deduped);
const doneNumbers = new Set(deduped.map((r) => r.issue_number));
perCase.push(...partialRows);
totalCost = partialRows.reduce((a, r) => a + r.costAmount, 0);
if (partialRows.length > 0) {
  console.log(`断点续跑：已完成 ${partialRows.length} 条，跳过继续`);
}
console.log("[调试] loader 后 key:", (process.env.DEEPSEEK_API_KEY??"(无)").length, "字符, sk-开头:", (process.env.DEEPSEEK_API_KEY??"").startsWith("sk-"));

function appendPartial(entry: PerCase): void {
  appendFileSync(PARTIAL_FILE, JSON.stringify(entry) + "\n", "utf8");
}

/** 免费中转通道分钟级抖动：零成本传输失败时按 30s/60s/120s 退避重试整条 case */
async function runWithRetry(event) {
  let res = await handleIssueEvent(event, { llm });
  for (const delay of [30_000, 60_000, 120_000]) {
    if (!res.escalated || (res.steps[0]?.costAmount ?? 0) > 0) return res;
    const why = res.actions[0]?.kind === "escalate" ? (res.actions[0] as { reason: string }).reason : "";
    console.log(`    … 传输失败，${delay / 1000}s 后重试：${why.slice(0, 120)}`);
    await new Promise((r) => setTimeout(r, delay));
    res = await handleIssueEvent(event);
  }
  return res;
}

let consecutiveTransportFails = 0;
for (const row of rows) {
  if (doneNumbers.has(row.issue_number)) continue; // 断点续跑：跳过已完成
  if (consecutiveTransportFails >= 3) {
    console.error("通道不可用（连续 3 条零成本传输失败），已熔断退出——稍后重跑（断点已保存）");
    process.exit(1);
  }
  const event: IssueEvent = {
    repo: row.repo,
    issueNumber: row.issue_number,
    title: row.title,
    body: row.body_excerpt,
    rawLabels: row.raw_labels,
  };
  const res = await runWithRetry(event);
  const step = res.steps[0];
  totalCost += step?.costAmount ?? 0;
  const predMain = res.triage ? mainOf(res.triage.labels) : null;
  const goldMain = mainOf(row.labels_gold);
  perCase.push({
    issue_number: row.issue_number,
    gold: goldMain,
    pred: predMain,
    correct: predMain === goldMain,
    nmiGold: (row.labels_gold ?? []).includes("needs-more-info"),
    nmiPred: (res.triage?.labels ?? []).includes("needs-more-info"),
    confidence: res.triage?.confidence ?? null,
    escalated: res.escalated,
    costAmount: step?.costAmount ?? 0,
    durationMs: step?.durationMs ?? 0,
    difficulty: row.difficulty,
    rationale: res.triage?.rationale ?? null,
  });
  const last = perCase[perCase.length - 1]!;
  if (last.escalated && last.costAmount === 0) {
    // 传输失败不落断点：该 case 留给下一个窗口重试，断点只累积有效结果
    consecutiveTransportFails++;
    if (consecutiveTransportFails >= 3) {
      console.error(`通道不可用（连续 3 条零成本传输失败），本轮完成 ${perCase.length}/${rows.length}——退出等下个窗口`);
      process.exit(1);
    }
    continue;
  }
  consecutiveTransportFails = 0;
  appendPartial(last);
  const mark = last.correct ? "✓" : "✗";
  const disp = predMain ?? "FAIL";
  console.log(
    `${mark} #${row.issue_number}  gold=${goldMain.padEnd(9)} pred=${disp.padEnd(9)} conf=${(res.triage?.confidence ?? 0).toFixed(2)}  ¥${(step?.costAmount ?? 0).toFixed(5)} ${step?.durationMs}ms`
  );
}

// ---- 汇总 ----
const n = perCase.length;
if (n < rows.length) {
  console.error(`本轮完成 ${n}/${rows.length}（通道窗口不足），断点已保存——再次运行继续`);
  process.exit(1);
}
const correct = perCase.filter((c) => c.correct).length;
const accuracy = n ? correct / n : 0;

const confusion = new Map<string, Map<string, number>>();
for (const c of perCase) {
  if (!confusion.has(c.gold)) confusion.set(c.gold, new Map());
  const m = confusion.get(c.gold)!;
  m.set(c.pred ?? "FAIL", (m.get(c.pred ?? "FAIL") ?? 0) + 1);
}

const nmiGoldRows = perCase.filter((c) => c.nmiGold);
const nmiHit = nmiGoldRows.filter((c) => c.nmiPred).length;
const nmiFalsePos = perCase.filter((c) => !c.nmiGold && c.nmiPred).length;

const fails = perCase.filter((c) => c.pred === null);
const latencies = perCase.map((c) => c.durationMs).sort((a, b) => a - b);
const p95 = latencies[Math.floor(n * 0.95)] ?? 0;
const easy = perCase.filter((c) => c.difficulty === "easy");
const hard = perCase.filter((c) => c.difficulty === "hard");

console.log("");
console.log("== 汇总 ==");
console.log(`准确率(主标签严格比对): ${correct}/${n} = ${(accuracy * 100).toFixed(1)}%`);
console.log(`解析失败: ${fails.length}${fails.map((f) => " #" + f.issue_number).join("")}`);
console.log(`nmi 命中: ${nmiHit}/${nmiGoldRows.length} | 误报: ${nmiFalsePos}`);
console.log(`easy 切片: ${easy.filter((c) => c.correct).length}/${easy.length} | hard 切片: ${hard.filter((c) => c.correct).length}/${hard.length}`);
console.log(`成本: 合计 ¥${totalCost.toFixed(4)} / 单条均值 ¥${(totalCost / Math.max(1, n)).toFixed(5)}`);
console.log(`延迟: p50 ${latencies[Math.floor(n / 2)]}ms | p95 ${p95}ms`);
console.log("");
console.log("混淆分布（gold → pred）:");
for (const [gold, m] of [...confusion.entries()].sort()) {
  console.log(`  ${gold.padEnd(9)} → ${[...m.entries()].sort((a, b) => b[1] - a[1]).map(([p, c]) => `${p}:${c}`).join(", ")}`);
}

const outDir = resolve(ROOT, "datasets/pilot");
mkdirSync(outDir, { recursive: true });
const ds = DATASET_VERSION ?? `v1-draft-n${rows.length}`;
const outFile = resolve(outDir, `${TAG}-${MODEL ?? resolveModel("triage")}-${DEFAULT_MODEL_CONFIG.version}-${PROMPT_VERSION}-${ds}.json`);
// 防覆盖：有效报告不可被后续（可能失败的）运行覆盖
if (existsSync(outFile) && !argv.includes("--force")) {
  console.error(`报告已存在，拒绝覆盖（加 --force 强制）：${outFile}`);
  process.exit(1);
}
writeFileSync(
  outFile,
  JSON.stringify(
    {
      model: MODEL ?? resolveModel("triage"),
      modelConfigVersion: DEFAULT_MODEL_CONFIG.version,
      promptVersion: PROMPT_VERSION,
      datasetVersion: ds,
      n,
      correct,
      accuracy,
      nmiHit,
      nmiGoldCount: nmiGoldRows.length,
      nmiFalsePos,
      totalCost,
      avgCost: totalCost / Math.max(1, n),
      p50LatencyMs: latencies[Math.floor(n / 2)] ?? 0,
      p95LatencyMs: p95,
      confusion: Object.fromEntries([...confusion.entries()].map(([g, m]) => [g, Object.fromEntries(m)])),
      perCase,
    },
    null,
    2
  ),
  "utf8"
);
unlinkSync(PARTIAL_FILE); // 断点文件已完成使命
console.log(`\n报告已写入: ${outFile}`);
