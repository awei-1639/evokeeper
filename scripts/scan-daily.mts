/**
 * 反应信号日扫（W4）—— design.md §5 "每日扫描已处理 issue，窗口 14 天"
 *
 * 流程：读轨迹库（traces.jsonl）→ 逐条拉 GitHub 时间线 → 映射 ReactionSignal →
 * judgeTrace 生成 JudgedTrace → 落盘 datasets/judged/judged.jsonl（整理管线的输入）。
 *
 * 注意：本脚本设计的输入是 **Bot 真实处理过的 issue**（信号 = 用户/维护者对 Bot 处置的反应）。
 * 对"离线评测轨迹"跑它得到的信号语义是issue 上的人类活动，只用于管线演练，不进门禁统计。
 *
 * 用法：
 *   pnpm scan:daily -- --limit=3          # 冒烟（读公开数据，零 scope token 即可）
 *   pnpm scan:daily                       # 全量
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RestGithubClient } from "../apps/agent/src/github-client";
import { JsonlTraceStore } from "../apps/agent/src/trace-store";
import { judgeTrace } from "../apps/worker/src/judge";
import { scanReactions, type ProcessedIssue } from "../apps/worker/src/reaction-collector";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const TRACE_FILE = resolve(ROOT, "datasets/traces/traces.jsonl");
const OUT_FILE = resolve(ROOT, "datasets/judged/judged.jsonl");

const envText = readFileSync(resolve(ROOT, ".env.local"), "utf8");
for (const line of envText.split("\n")) {
  const m = /^([A-Z_]+)\s*=\s*([^#]*?)\s*(?:#.\*)?$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
if (!process.env.GITHUB_TOKEN) {
  console.error("缺少 GITHUB_TOKEN");
  process.exit(1);
}

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const LIMIT = arg("limit") ? Number(arg("limit")) : Infinity;
const BOT_LOGIN = arg("bot") ?? "evokeeper-bot";

if (!existsSync(TRACE_FILE)) {
  console.error(`轨迹库不存在：${TRACE_FILE}（先跑 eval:run 或接真实流量）`);
  process.exit(1);
}

const store = new JsonlTraceStore(TRACE_FILE);
const client = new RestGithubClient(process.env.GITHUB_TOKEN as string);

async function allTraces() {
  return store.all();
}

const traces = (await allTraces()).slice(0, LIMIT);
const processed: ProcessedIssue[] = traces.map((t) => ({
  repo: t.repo,
  issueNumber: t.issueNumber,
  // 信号窗口从轨迹完成时刻起算（真实流量时=Bot 处理完成；离线轨迹=评测执行时刻）
  processedAt: t.finishedAt,
  botLogin: BOT_LOGIN,
}));

console.log(`== scan:daily == 待扫 ${processed.length} 条（窗口 14 天，bot=${BOT_LOGIN}）`);
const scans = await scanReactions(client, processed);

const verdicts = { failure: 0, success: 0, unclear: 0 };
const lines: string[] = [];
for (let i = 0; i < traces.length; i++) {
  const trace = traces[i];
  const signals = scans[i]?.signals ?? [];
  const judged = judgeTrace(trace, signals);
  verdicts[judged.verdict]++;
  lines.push(JSON.stringify(judged));
  if (judged.verdict !== "unclear") {
    console.log(`  ${trace.id} #${trace.issueNumber} → ${judged.verdict}（${signals.map((s) => s.kind).join(", ")}）`);
  }
}

mkdirSync(resolve(ROOT, "datasets/judged"), { recursive: true });
writeFileSync(OUT_FILE, lines.join("\n") + "\n", "utf8");
console.log(
  `\n完成：failure ${verdicts.failure} / success ${verdicts.success} / unclear ${verdicts.unclear}` +
    `\nJudgedTrace 已写入: ${OUT_FILE}（verdict≠unclear 的部分是整理管线输入）`
);
