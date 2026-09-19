/** 一次性诊断：重跑 pilot 中解析失败的样本，打印模型原始输出与校验错误 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLlm } from "../packages/llm/src/index";
import { buildTriageMessages, parseTriage } from "../apps/agent/src/triage";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
for (const line of readFileSync(resolve(ROOT, ".env.local"), "utf8").split("\n")) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const IDS = [13851, 14452, 13951, 13837];
const rows = readFileSync(resolve(ROOT, "datasets/drafts/alibaba_nacos.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));

const llm = createLlm();
for (const num of IDS) {
  const row = rows.find((r) => r.issue_number === num);
  if (!row) continue;
  const { system, user } = buildTriageMessages({
    repo: row.repo, issueNumber: row.issue_number, title: row.title, body: row.body_excerpt, rawLabels: row.raw_labels,
  });
  const res = await llm.json({
    purpose: "triage", promptVersion: "tp-1.0", system, user, validate: parseTriage,
  });
  console.log(`\n===== #${num} ok=${res.ok} error=${res.error} attempts=${res.meta.attempts} =====`);
  console.log("RAW:", res.raw.slice(0, 600));
}
