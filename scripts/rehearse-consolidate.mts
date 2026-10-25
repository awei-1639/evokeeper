/**
 * 睡眠整理演练（W6 前置）—— 重放轨迹 + gold 判定 → 候选经验
 *
 * 背景：线上真实信号要攒两周才有量；整理管线（聚类→归纳→候选）先用重放轨迹
 * 演练转通。判定信号用 labels_gold 主标签是否与 Bot 处置一致（success/failure），
 * 语义上等价于"维护者最终判定与 Bot 是否一致"（labels_gold 本就来自维护者标注）。
 *
 * 纪律：
 * - judgeRuleVersion 固定 "rehearsal-gold-match-v1"：演练产物与真实 scan:daily 的
 *   JudgedTrace（judgeRuleVersion 不同）天然可区分，绝不混入门禁统计；
 * - 候选 status=proposed 只进人工评审队列，不生效（R1：不经门禁不得生效）；
 * - holdout 不参与（重放轨迹只有 dev 集）。
 *
 * 用法：pnpm tsx scripts/rehearse-consolidate.mts
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { JudgedTrace, Trace } from "../packages/core/src/index";
import { createLlm, liveModelConfigFromEnv } from "../packages/llm/src/index";
import { runConsolidation } from "../apps/worker/src/consolidate";
import { JsonlCandidateStore } from "../apps/worker/src/candidate-store";
import { JsonlTraceStore } from "../apps/agent/src/trace-store";

const HERE = (await import("node:path")).dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const REPLAY_FILE = resolve(ROOT, "datasets/traces/replay-traces.jsonl");
const GOLD_FILE = resolve(ROOT, "datasets/drafts/alibaba_nacos.jsonl");
const CANDIDATE_FILE = resolve(ROOT, "datasets/candidates/candidates.jsonl");

const envText = readFileSync(resolve(ROOT, ".env.local"), "utf8");
for (const line of envText.split("\n")) {
  const m = /^([A-Z_]+)\s*=\s*(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const MAIN = new Set(["bug", "feature", "question", "duplicate"]);

// gold 主标签表（按 issue_number 索引）
const gold = new Map<number, string[]>();
for (const line of readFileSync(GOLD_FILE, "utf8").trim().split("\n")) {
  const r = JSON.parse(line) as { issue_number: number; labels_gold: string[] };
  gold.set(r.issue_number, r.labels_gold);
}
const mainOf = (labels: string[] | undefined) =>
  (labels ?? []).find((l) => MAIN.has(l)) ?? (labels ?? [])[0] ?? "invalid";

const traces: Trace[] = existsSync(REPLAY_FILE)
  ? await new JsonlTraceStore(REPLAY_FILE).all()
  : [];
console.log(`重放轨迹 ${traces.length} 条载入`);

// JudgedTrace 构造：Bot 主标签 vs gold 主标签
const judged: JudgedTrace[] = traces.map((trace) => {
  const botLabels = trace.finalActions.flatMap((a) => (a.kind === "addLabels" ? a.labels : []));
  const want = mainOf(gold.get(trace.issueNumber));
  const got = mainOf(botLabels);
  const agree = want === got;
  return {
    trace,
    reactions: [
      {
        kind: agree ? "no_reaction" : "maintainer_relabel",
        occurredAt: trace.finishedAt,
        detail: `rehearsal: gold=${want} bot=${got}`,
      },
    ],
    verdict: agree ? "success" : "failure",
    judgeRuleVersion: "rehearsal-gold-match-v1",
    humanReviewed: false,
  };
});
const ok = judged.filter((j) => j.verdict === "success").length;
console.log(`判定：success ${ok} / failure ${judged.length - ok}（进入管线 ${judged.length} 条）`);

// 整理（consolidate 档 → deepseek-v4-pro，liveModelConfig 按 §9.1 处理降级）
const llm = createLlm({ config: liveModelConfigFromEnv(console.log) });
const result = await runConsolidation({ repo: "alibaba/nacos", judged, llm });

console.log(`\n== 整理结果 ==`);
console.log(`job: ${result.job.id} | 输入 ${result.job.inputTraceIds.length} 条`);
console.log(`低频簇（<${result.job.clusterParams.minClusterSize} 不成候选）: ${result.job.lowFrequencyClusters.length} 个`);
console.log(`候选: ${result.candidates.length} 个（上限 ${result.job.clusterParams.maxCandidates}）`);
console.log(`被拒: ${result.rejected.length}`);

mkdirSync(resolve(ROOT, "datasets/candidates"), { recursive: true });
const store = new JsonlCandidateStore(CANDIDATE_FILE);
for (const c of result.candidates) {
  await store.append(c);
  console.log(`\n[${c.type}] ${c.pattern}`);
  console.log(`  切片: ${c.expectedSlice}`);
  console.log(`  证据: ${c.evidenceTraceIds.length} 条 | id: ${c.id}`);
  console.log(`  正文: ${c.content.slice(0, 200)}${c.content.length > 200 ? "…" : ""}`);
}
console.log(`\n候选已写入 ${CANDIDATE_FILE}（status=proposed，等人工评审 + eval:gate——R1）`);
