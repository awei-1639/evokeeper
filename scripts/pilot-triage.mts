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
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
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
  const m = /^([A-Z_]+)s*=s*([^#]*?)s*(?:#.*)?$/.exec(line.trim());
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
const PROMPT_VERSION = "tp-1.2"; // prompt 升级时同步改这里，报告文件名随之区分

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

for (const row of rows) {
  const event: IssueEvent = {
    repo: row.repo,
    issueNumber: row.issue_number,
    title: row.title,
    body: row.body_excerpt,
    rawLabels: row.raw_labels,
  };
  const res = await handleIssueEvent(event);
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
  const mark = perCase[perCase.length - 1]?.correct ? "✓" : "✗";
  const disp = predMain ?? "FAIL";
  console.log(
    `${mark} #${row.issue_number}  gold=${goldMain.padEnd(9)} pred=${disp.padEnd(9)} conf=${(res.triage?.confidence ?? 0).toFixed(2)}  ¥${(step?.costAmount ?? 0).toFixed(5)} ${step?.durationMs}ms`
  );
}

// ---- 汇总 ----
const n = perCase.length;
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
console.log(`\n报告已写入: ${outFile}`);
