/**
 * LLM 冒烟：3 条多样化样本（question/invalid/bug 各一）走完整分诊链路，
 * 验证供应商/中转站连通性与 JSON 输出兼容性。换供应商或换端点后先跑这个。
 * 用法：pnpm tsx scripts/smoke-llm.mts --model=<模型名>
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODEL_CONFIG, createLlm, type ModelConfig } from "../packages/llm/src/index";
import { handleIssueEvent } from "../apps/agent/src/index";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const envText = readFileSync(resolve(ROOT, ".env.local"), "utf8");
for (const line of envText.split("\n")) {
  // 容忍等号两侧空格与行内注释：KEY = value # comment
  const m = /^([A-Z_]+)\s*=\s*([^#]*?)\s*(?:#.*)?$/.exec(line.trim());
  if (m && m[1] && m[2] !== undefined && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const argModel = process.argv.slice(2).find((a) => a.startsWith("--model="))?.split("=")[1];
if (!argModel) {
  console.error("用法: tsx scripts/smoke-llm.mts --model=<模型名>");
  process.exit(1);
}
const config: ModelConfig = {
  ...DEFAULT_MODEL_CONFIG,
  routing: { ...DEFAULT_MODEL_CONFIG.routing, triage: argModel },
};
console.log("模型:", argModel, "| DEEPSEEK_BASE_URL =", process.env.DEEPSEEK_BASE_URL ?? "(未设置——仍走官方端点!)");

const llm = createLlm({ config });

const all = readFileSync(resolve(ROOT, "datasets/drafts/alibaba_nacos.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));
// 三类各一：question / invalid(spam) / bug
const picks = [13846, 14409, 15206];
for (const num of picks) {
  const row = all.find((r) => r.issue_number === num);
  const res = await handleIssueEvent(
    { repo: row.repo, issueNumber: row.issue_number, title: row.title, body: row.body_excerpt },
    { llm }
  );
  const step = res.steps[0];
  const escalateReason =
    res.actions[0]?.kind === "escalate" ? (res.actions[0] as { reason: string }).reason : "";
  console.log(
    `#${num} gold=${JSON.stringify(row.labels_gold)} → pred=${res.triage ? JSON.stringify(res.triage.labels) : "FAIL"} conf=${res.triage?.confidence ?? "-"} | ¥${(step?.costAmount ?? 0).toFixed(4)} | ${step?.durationMs}ms` +
      (res.escalated ? ` | ESCALATE: ${escalateReason}` : "")
  );
}
console.log("冒烟完成");
