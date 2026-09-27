#!/usr/bin/env node
/**
 * holdout 分层锁定 —— docs/annotation-report-ai-r1.md §6 提议的落地脚本
 *
 * 前置纪律（guideline §7）：holdout 锁定必须在 κ≥0.75 达标 + 15 条仲裁完成之后执行，
 * split=holdout 定稿后永不修改、永不增删。本脚本默认 dry-run 只打印方案；
 * 确认后执行 `node scripts/select-holdout.mjs --apply` 才写回主文件。
 *
 * 方案（种子固定可复现）：
 *   1. 从 300 条全量按主标签分层等比抽 200 条作为 v1（bug/question/feature/invalid/duplicate）；
 *   2. v1 内再按主标签分层抽 40 条 → split=holdout；其余 160 条 → dev；
 *   3. 未入选的 100 条为扩充池（split 保持 dev，membership 记录在
 *      datasets/review/v1-assignment.json，供 W4 评测 harness 区分）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "datasets", "drafts", "alibaba_nacos.jsonl");
const OUT = path.join(ROOT, "datasets", "review", "v1-assignment.json");

const APPLY = process.argv.includes("--apply");
const SEED = 42;

// mulberry32：确定性 PRNG，方案可复现可审计
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);

/** 洗牌后取前 n 条（按给定的组内列表） */
function sampleN(list, n) {
  const shuffled = list.slice().sort(() => rnd() - 0.5);
  return shuffled.slice(0, n);
}

const MAIN = ["bug", "feature", "question", "duplicate", "invalid"];
const mainOf = (r) => r.labels_gold.find((l) => MAIN.includes(l)) ?? "invalid";

const recs = fs
  .readFileSync(DATA, "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));
const bad = recs.filter((r) => r.split === "holdout");
if (bad.length && !APPLY) {
  console.error(`警告：已有 ${bad.length} 条 holdout，重复运行会重新洗牌。`);
}

const byLabel = {};
for (const r of recs) (byLabel[mainOf(r)] ??= []).push(r);

// 1) 分层等比选 v1-200
const N_V1 = 200;
const v1Take = {};
let sum = 0;
for (const [k, v] of Object.entries(byLabel)) {
  v1Take[k] = Math.max(1, Math.round((N_V1 * v.length) / recs.length));
  sum += v1Take[k];
}
// 修正到恰好 200
const labelOrder = Object.keys(byLabel).sort();
let i = 0;
while (sum !== N_V1) {
  const k = labelOrder[i % labelOrder.length];
  if (sum > N_V1 && v1Take[k] > 1) {
    v1Take[k]--;
    sum--;
  } else if (sum < N_V1 && v1Take[k] < byLabel[k].length) {
    v1Take[k]++;
    sum++;
  }
  i++;
}
const v1 = [];
for (const [k, n] of Object.entries(v1Take)) v1.push(...sampleN(byLabel[k], n));

// 2) v1 内分层抽 40 holdout
const N_HOLDOUT = 40;
const v1ByLabel = {};
for (const r of v1) (v1ByLabel[mainOf(r)] ??= []).push(r);
const holdTake = {};
sum = 0;
for (const [k, v] of Object.entries(v1ByLabel)) {
  holdTake[k] = Math.max(1, Math.round((N_HOLDOUT * v.length) / v1.length));
  sum += holdTake[k];
}
i = 0;
while (sum !== N_HOLDOUT) {
  const k = labelOrder[i % labelOrder.length];
  if (sum > N_HOLDOUT && holdTake[k] > 1) {
    holdTake[k]--;
    sum--;
  } else if (sum < N_HOLDOUT && holdTake[k] < v1ByLabel[k].length) {
    holdTake[k]++;
    sum++;
  }
  i++;
}
const holdout = [];
for (const [k, n] of Object.entries(holdTake)) holdout.push(...sampleN(v1ByLabel[k], n));

const holdoutIds = new Set(holdout.map((r) => r.id));
const v1Ids = new Set(v1.map((r) => r.id));
const dev160 = v1.filter((r) => !holdoutIds.has(r.id));
const expansion = recs.filter((r) => !v1Ids.has(r.id));

console.log(`== holdout 方案（seed=${SEED}，dry-run=${APPLY ? "否" : "是"}）==`);
console.log(`v1 总量: ${v1.length}（dev ${dev160.length} + holdout ${holdout.length}）| 扩充池: ${expansion.length}`);
console.log(`holdout 分层: ${JSON.stringify(holdTake)}`);
for (const r of holdout) console.log(`  ${r.id} #${r.issue_number} [${mainOf(r)}] ${(r.title || "").slice(0, 40)}`);

if (APPLY) {
  for (const r of recs) {
    if (holdoutIds.has(r.id)) r.split = "holdout";
  }
  fs.writeFileSync(DATA + ".tmp", recs.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  fs.renameSync(DATA + ".tmp", DATA);
  fs.writeFileSync(
    OUT,
    JSON.stringify(
      {
        seed: SEED,
        createdAt: new Date().toISOString().slice(0, 10),
        note: "v1 membership：dev160 + holdout40 为 v1；expansion100 为 W4 扩充池（split 保持 dev）",
        v1: { dev: dev160.map((r) => r.id), holdout: holdout.map((r) => r.id) },
        expansion: expansion.map((r) => r.id),
      },
      null,
      1
    ),
    "utf8"
  );
  console.log(`\n已写回：split=holdout × ${holdout.length}，membership → ${path.relative(ROOT, OUT)}`);
} else {
  console.log("\n（dry-run：未写任何文件。κ≥0.75 达标 + 仲裁完成后加 --apply 落锁。）");
}
