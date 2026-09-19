/**
 * 分诊试跑（pilot 车辆）—— 对应 design.md §3 / §9.1
 *
 * 两个模式：
 * 1. 默认 dry-run：不联网，只装配提示词并打印，用于人工审阅真实输入长什么样；
 * 2. --call：真实调用（需 DEEPSEEK_API_KEY），跑分诊并汇总成本/延迟分布。
 *
 * 用法：
 *   pnpm triage:dryrun                      # 打印第 1 条的完整提示词
 *   pnpm triage:dryrun -- --limit 20        # 汇总 20 条的体量预估
 *   pnpm triage:dryrun -- --limit 20 --call # 真实跑 20 条
 *
 * 约定：真实调用结果写入 datasets/pilot/，供 pilot 与基线复用，不覆盖人工标注草稿。
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { handleIssueEvent, type IssueEvent } from "../apps/agent/src/index";
import {
  TRIAGE_BODY_MAX_CHARS,
  TRIAGE_PROMPT_VERSION,
  buildTriageMessages,
} from "../apps/agent/src/triage";
import { DEFAULT_MODEL_CONFIG, isOffPeakNow, resolveModel } from "../packages/llm/src/config";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DEFAULT_DATASET = resolve(ROOT, "datasets/drafts/alibaba_nacos.jsonl");

interface DraftRow {
  repo: string;
  issue_number: number;
  title: string;
  body_excerpt: string;
  raw_labels: string[];
  url: string;
}

function parseArgs(argv: string[]): { limit: number; call: boolean; dataset: string } {
  const get = (name: string): string | null => {
    const i = argv.indexOf(name);
    return i >= 0 ? (argv[i + 1] ?? null) : null;
  };
  return {
    limit: Number(get("--limit") ?? 1),
    call: argv.includes("--call"),
    dataset: get("--dataset") ?? DEFAULT_DATASET,
  };
}

function loadRows(path: string, limit: number): DraftRow[] {
  const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  return lines.slice(0, limit).map((l) => JSON.parse(l) as DraftRow);
}

function toEvent(row: DraftRow): IssueEvent {
  return {
    repo: row.repo,
    issueNumber: row.issue_number,
    title: row.title,
    body: row.body_excerpt,
    rawLabels: row.raw_labels,
  };
}

/** 中英混排的粗估：中文约 1 字 1 token，英文约 4 字符 1 token */
function roughTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const rest = text.length - cjk;
  return Math.round(cjk + rest / 4);
}

const args = parseArgs(process.argv.slice(2));
const rows = loadRows(args.dataset, args.limit);
const model = resolveModel("triage", DEFAULT_MODEL_CONFIG);

console.log("== EvoKeeper 分诊试跑 ==");
console.log(`数据集     : ${args.dataset}`);
console.log(`样本数     : ${rows.length}`);
console.log(`prompt 版本: ${TRIAGE_PROMPT_VERSION}`);
console.log(`模型配置   : ${DEFAULT_MODEL_CONFIG.version} → ${model}`);
console.log(`当前时段   : ${isOffPeakNow(new Date(), model) ? "空闲（5 折）" : "高峰（原价）"}`);
console.log(`正文上限   : ${TRIAGE_BODY_MAX_CHARS} 字符（超出截断）`);
console.log("");

if (!args.call) {
  if (rows.length > 1) {
    let sumIn = 0;
    for (const row of rows) {
      const { system, user } = buildTriageMessages(toEvent(row));
      sumIn += roughTokens(system) + roughTokens(user);
    }
    console.log(
      `体量粗估: 输入合计约 ${sumIn} tokens，单条均值约 ${Math.round(sumIn / rows.length)} tokens`
    );
    console.log(`（不含输出；deepseek-v4-flash 空闲价约 ¥1.5/百万输入 token）`);
    console.log("");
  }
  const first = rows[0];
  if (!first) throw new Error("数据集为空");
  const { system, user } = buildTriageMessages(toEvent(first));
  console.log(`---- system (${system.length} 字符 / 约 ${roughTokens(system)} tokens) ----`);
  console.log(system);
  console.log("");
  console.log(`---- user (${user.length} 字符 / 约 ${roughTokens(user)} tokens) ----`);
  console.log(user);
  console.log("");
  console.log("（dry-run 结束。设置 DEEPSEEK_API_KEY 后加 --call 可真实调用）");
  process.exit(0);
}

const results: unknown[] = [];
let totalCost = 0;
let totalTokens = 0;

for (const row of rows) {
  const res = await handleIssueEvent(toEvent(row));
  const step = res.steps[0];
  totalCost += step?.costAmount ?? 0;
  totalTokens += (step?.inputTokens ?? 0) + (step?.outputTokens ?? 0);
  results.push({
    repo: row.repo,
    issue_number: row.issue_number,
    url: row.url,
    raw_labels: row.raw_labels,
    triage: res.triage,
    actions: res.actions,
    escalated: res.escalated,
    model: step?.model,
    promptVersion: step?.promptVersion,
    costAmount: step?.costAmount,
    tokens: (step?.inputTokens ?? 0) + (step?.outputTokens ?? 0),
    durationMs: step?.durationMs,
  });
  const verdict = res.escalated ? "escalate" : (res.triage?.labels.join("+") ?? "-");
  console.log(
    `#${row.issue_number}  ${verdict.padEnd(24)} ¥${(step?.costAmount ?? 0).toFixed(5)}  ${step?.durationMs}ms`
  );
}

console.log("");
console.log(`合计: ${rows.length} 条 / ${totalTokens} tokens / ¥${totalCost.toFixed(4)}`);
console.log(`单条均值: ¥${(totalCost / Math.max(1, rows.length)).toFixed(5)}`);

const outDir = resolve(ROOT, "datasets/pilot");
const outFile = resolve(outDir, `triage-${DEFAULT_MODEL_CONFIG.version}-${TRIAGE_PROMPT_VERSION}.jsonl`);
mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, results.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
console.log(`已写入: ${outFile}`);
