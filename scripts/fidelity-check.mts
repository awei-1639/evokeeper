/**
 * 传输保真度检查（换通道/换端点后必跑）：抽样 v1 dev case 走当前 DEEPSEEK_BASE_URL 重跑，
 * 与官方通道的逐条预测对比——防中转站静默降智（账面 A 模型实际路由阉割版）。
 * 判据：双方有效预测一致率 ≥90% 才可信；失败率高说明额度/套餐有问题。
 * 用法：pnpm tsx scripts/fidelity-check.mts [--stride=8] [--limit=20]
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODEL_CONFIG, createLlm, type ModelConfig } from "../packages/llm/src/index";
import { handleIssueEvent, type IssueEvent } from "../apps/agent/src/index";
import { loadGoldenSet, mainLabelOf } from "../packages/eval/src/index";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const envText = readFileSync(resolve(ROOT, ".env.local"), "utf8");
for (const line of envText.split("\n")) {
  const m = /^([A-Z_]+)\s*=\s*([^#]*?)\s*(?:#.*)?$/.exec(line.trim());
  if (m && m[1] && m[2] !== undefined && !process.env[m[1]]) process.env[m[1]] = m[2];
}

// 官方通道的逐条预测（v1 dev 基线）
const official = JSON.parse(
  readFileSync(resolve(ROOT, "datasets/eval/run-baseline-dev-deepseek-v4-flash-mc-1.0-v1.json"), "utf8")
) as { perCaseDetail: Array<{ caseId: string; predMain: string | null; goldMain: string }> };
const officialPred = new Map(official.perCaseDetail.map((c) => [c.caseId, c.predMain]));

// 抽样：v1.dev 每 8 条取 1 ≈ 20 条
const assignment = JSON.parse(
  readFileSync(resolve(ROOT, "datasets/review/v1-assignment.json"), "utf8")
) as { v1: { dev: string[] } };
const cases = loadGoldenSet(resolve(ROOT, "datasets/drafts/alibaba_nacos.jsonl"), { split: "dev" }).filter(
  (c) => assignment.v1.dev.includes(c.id)
);
const argv2 = process.argv.slice(2);
const stride = Number(argv2.find((a) => a.startsWith("--stride="))?.split("=")[1] ?? 8);
const limit = Number(argv2.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? 20);
// 待检模型：默认基线模型；中转站模型名不同时用 --model= 显式指定
const probeModel = argv2.find((a) => a.startsWith("--model="))?.split("=")[1] ?? "deepseek-v4-flash";
const sampled = cases.filter((_, i) => i % stride === 0).slice(0, limit);

const config: ModelConfig = {
  ...DEFAULT_MODEL_CONFIG,
  routing: { ...DEFAULT_MODEL_CONFIG.routing, triage: probeModel },
};
const llm = createLlm({ config });

let same = 0;
let sameGold = 0;
let bothNonNull = 0;
const diffs: string[] = [];
const delayMs = Number(argv2.find((a) => a.startsWith("--delay-ms="))?.split("=")[1] ?? 0);
for (const [idx, c] of sampled.entries()) {
  if (delayMs > 0 && idx > 0) {
    process.stdout.write(`  (${idx + 1}/${sampled.length} 等待 ${delayMs}ms…)\r`);
    await new Promise((s) => setTimeout(s, delayMs));
  }
  const res = await handleIssueEvent(
    { repo: c.repo, issueNumber: c.issueNumber, title: c.title, body: c.bodyExcerpt } as IssueEvent,
    { llm }
  );
  const relayPred = res.triage ? mainLabelOf(res.triage.labels) : null;
  const offPred = officialPred.get(c.id) ?? null;
  if (relayPred !== null && offPred !== null) {
    bothNonNull++;
    if (relayPred === offPred) same++;
  }
  if (relayPred === c.goldMain) sameGold++;
  if (relayPred !== offPred) diffs.push(`${c.id} 官方=${offPred ?? "FAIL"} 中转=${relayPred ?? "FAIL"}`);
}
console.log('');
console.log('待检模型:', process.argv.slice(2).find(a=>a.startsWith("--model="))?.split("=")[1] ?? "deepseek-v4-flash");
console.log(`样本: ${sampled.length} | 双方有效: ${bothNonNull} | 预测一致: ${same}/${bothNonNull} = ${((same / Math.max(1, bothNonNull)) * 100).toFixed(0)}%`);
console.log(`对 gold 一致率（中转）: ${sameGold}/${sampled.length}`);
if (diffs.length) console.log("分歧明细:\n  " + diffs.join("\n  "));
