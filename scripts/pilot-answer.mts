/**
 * 回答链路基线 pilot（W2 DoD：RAG 问答跑通 + 成本记录在案）
 *
 * 口径说明：
 * - 样本：golden set 中 qa 非空的记录，等距抽样（确定性）；
 * - 检索语料 = 全量 300 条 issue + 维护者回复（社区已积累知识）。问题源自语料中的 issue，
 *   检索命中源 issue 是符合运行时真实场景的（用户问"社区解决过的问题"）——这不是泄漏，
 *   但要点覆盖率评分（LLM-judge 五维）留待 judge 档 key 就绪后进行，本报告只记机械指标；
 * - 引用护栏在链路内已执行，报告记录剥离次数作为"臆造引用倾向"的观测值。
 *
 * 用法：
 *   pnpm pilot:answer -- --limit=30            # 默认 30 条
 *   pnpm pilot:answer -- --limit=50 --k=8
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MODEL_CONFIG,
  createLlm,
  type ModelConfig,
} from "../packages/llm/src/index";
import { BM25Index, buildEvidence, loadCorpusFromJsonl } from "../apps/agent/src/retrieval";
import { answerQuestion } from "../apps/agent/src/answer";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DATA = resolve(ROOT, "datasets/drafts/alibaba_nacos.jsonl");

// ---- 加载 .env.local ----
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
const kArg = argv.find((a) => a.startsWith("--k="));
const LIMIT = limitArg ? Number(limitArg.split("=")[1]) : 30;
const K = kArg ? Number(kArg.split("=")[1]) : 5;
const PROMPT_VERSION = "ap-1.0";

// answer 档首选 qwen3-max 无 key，按 §9.1 用备选 deepseek-v4-pro 跑基线（报告中如实记录模型）
const ANSWER_MODEL = "deepseek-v4-pro";
const config: ModelConfig = {
  ...DEFAULT_MODEL_CONFIG,
  routing: { ...DEFAULT_MODEL_CONFIG.routing, answer: ANSWER_MODEL },
};
const llm = createLlm({ config });

// ---- 语料与样本 ----
const allRows = readFileSync(DATA, "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));
const qaRows = allRows.filter((r) => r.qa && typeof r.qa.question === "string");
const step = Math.max(1, Math.floor(qaRows.length / LIMIT));
const rows = qaRows.filter((_, i) => i % step === 0).slice(0, LIMIT);

const corpus = loadCorpusFromJsonl(DATA);
const index = new BM25Index(corpus);
console.log("== EvoKeeper 回答基线 pilot ==");
console.log(`模型: ${ANSWER_MODEL} | prompt: ${PROMPT_VERSION} | 样本: ${rows.length}/${qaRows.length} | 语料: ${index.size} 条 | top-${K}`);

interface PerCase {
  issue_number: number;
  question: string;
  answer: string;
  citations: string[];
  confidence: number | null;
  suspicious: boolean;
  stripped: string[];
  evidenceNumbers: number[];
  sourceHit: boolean;
  escalated: boolean;
  error: string | null;
  costAmount: number;
  durationMs: number;
  goldOutline: string;
}

const perCase: PerCase[] = [];
let totalCost = 0;
let strippedTotal = 0;

for (const row of rows) {
  const matches = index.search(row.qa.question, K);
  const evidence = buildEvidence(matches);
  const evidenceNumbers = evidence.map((e) => e.issueNumber);
  const res = await answerQuestion(
    { repo: row.repo, question: row.qa.question, evidence },
    { llm }
  );
  const stepMeta = res.steps[0];
  totalCost += stepMeta?.costAmount ?? 0;
  strippedTotal += res.strippedCitations.length;
  perCase.push({
    issue_number: row.issue_number,
    question: row.qa.question,
    answer: res.answer,
    citations: res.citations,
    confidence: res.confidence,
    suspicious: res.suspicious,
    stripped: res.strippedCitations,
    evidenceNumbers,
    sourceHit: evidenceNumbers.includes(row.issue_number),
    escalated: res.escalated,
    error: res.error,
    costAmount: stepMeta?.costAmount ?? 0,
    durationMs: stepMeta?.durationMs ?? 0,
    goldOutline: row.qa.ideal_answer_outline ?? "",
  });
  const cite = res.citations.length > 0 ? "引用" + res.citations.length : "无引用";
  console.log(
    `${res.escalated ? "×" : "✓"} #${row.issue_number} ${cite} src=${evidenceNumbers.includes(row.issue_number) ? "命中" : "未中"} ¥${(stepMeta?.costAmount ?? 0).toFixed(4)} ${stepMeta?.durationMs}ms`
  );
}

// ---- 汇总 ----
const n = perCase.length;
const latencies = perCase.map((c) => c.durationMs).sort((a, b) => a - b);
const withCitation = perCase.filter((c) => c.citations.length > 0).length;
const sourceHits = perCase.filter((c) => c.sourceHit).length;
const escalated = perCase.filter((c) => c.escalated).length;
const suspicious = perCase.filter((c) => c.suspicious).length;

console.log("");
console.log("== 汇总 ==");
console.log(`完成: ${n - escalated}/${n} | 解析失败(escalate): ${escalated}`);
const errKinds: Record<string, number> = {};
for (const c of perCase.filter((x) => x.error)) {
  const key = (c.error ?? "unknown").slice(0, 80);
  errKinds[key] = (errKinds[key] ?? 0) + 1;
}
for (const [k, v] of Object.entries(errKinds)) console.log(`  失败原因 ×${v}: ${k}`);
console.log(`检索命中源 issue: ${sourceHits}/${n} | 回答带真实引用: ${withCitation}/${n}`);
console.log(`护栏剥离臆造引用: ${strippedTotal} 处 | 注入嫌疑问题: ${suspicious}`);
console.log(`成本: 合计 ¥${totalCost.toFixed(4)} / 单条均值 ¥${(totalCost / Math.max(1, n)).toFixed(4)}`);
console.log(`延迟: p50 ${latencies[Math.floor(n / 2)] ?? 0}ms | p95 ${latencies[Math.floor(n * 0.95)] ?? 0}ms`);

const outDir = resolve(ROOT, "datasets/pilot");
mkdirSync(outDir, { recursive: true });
const outFile = resolve(
  outDir,
  `answer-baseline-${ANSWER_MODEL}-${DEFAULT_MODEL_CONFIG.version}-${PROMPT_VERSION}-v1-qa-n${n}-k${K}.json`
);
// 防覆盖：有效报告不可被后续（可能失败的）运行覆盖——余额/网络事故的教训
if (existsSync(outFile) && !argv.includes("--force")) {
  console.error(`报告已存在，拒绝覆盖（加 --force 强制）：${outFile}`);
  process.exit(1);
}
writeFileSync(
  outFile,
  JSON.stringify(
    {
      model: ANSWER_MODEL,
      modelConfigVersion: DEFAULT_MODEL_CONFIG.version,
      promptVersion: PROMPT_VERSION,
      datasetVersion: `v1-qa-n${qaRows.length}`,
      note: "answer 档首选 qwen3-max 无 key，按 §9.1 用备选 deepseek-v4-pro；检索=BM25（W4 换 embedding+pgvector）；要点覆盖率评分待 judge 档就绪",
      retrieval: { method: "bm25-cjk-bigram", topK: K, corpusSize: index.size },
      n,
      escalated,
      withCitation,
      sourceHitRate: sourceHits / Math.max(1, n),
      strippedCitationsTotal: strippedTotal,
      suspicious,
      totalCost,
      avgCost: totalCost / Math.max(1, n),
      p50LatencyMs: latencies[Math.floor(n / 2)] ?? 0,
      p95LatencyMs: latencies[Math.floor(n * 0.95)] ?? 0,
      perCase,
    },
    null,
    2
  ),
  "utf8"
);
console.log(`\n报告已写入: ${outFile}`);
