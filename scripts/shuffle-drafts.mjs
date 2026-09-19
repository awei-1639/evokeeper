/**
 * 标注顺序重排 —— 解决"顺列表标 = 时间偏差"
 *
 * 问题：草稿池按 created_at 倒序（新→旧），每月一批。若从第一条往下标，
 * 前 50 条 pilot 会全是最近两个月的 issue，而近期 issue 维护者回复更完整
 * （"答案总是存在"的乐观偏差），用它选模型会选错。
 *
 * 做法：按月分层 + 固定种子随机交错重排。重排后：
 *   - 前 50 条  = pilot 集（13 个月均匀覆盖，可直接跑模型选型）
 *   - 前 200 条 = v1 golden set（dev 160 : holdout 40，划分留给 split-dataset）
 * 重排可复现（seed 固定），原始顺序备份为 *.original-order.jsonl。
 *
 * 用法：node scripts/shuffle-drafts.mjs [文件路径]
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const target = process.argv[2] ?? resolve(ROOT, "datasets/drafts/alibaba_nacos.jsonl");

/** mulberry32：固定种子，保证任何人重跑都得到同一顺序 */
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rand) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const rows = readFileSync(target, "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

// 备份原始顺序（只做一次，避免二次运行覆盖成已打乱的版本）
const backup = `${target}.original-order.jsonl`;
if (!existsSync(backup)) {
  writeFileSync(backup, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  console.log(`已备份原始顺序 → ${backup}`);
}

const rand = mulberry32(20260914);

// 按月分组
const byMonth = new Map();
for (const r of rows) {
  const m = (r.created_at ?? "").slice(0, 7) || "unknown";
  if (!byMonth.has(m)) byMonth.set(m, []);
  byMonth.get(m).push(r);
}

// 每月内部打乱，然后 round-robin 交错
const months = [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]));
const queues = months.map(([, list]) => shuffle(list, rand));
const out = [];
let drained = false;
while (!drained) {
  drained = true;
  for (const q of queues) {
    if (q.length > 0) {
      out.push(q.shift());
      drained = false;
    }
  }
}

writeFileSync(target, out.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

// 校验：前 50 / 前 200 的月份覆盖
function coverage(n) {
  const c = new Map();
  for (const r of out.slice(0, n)) {
    const m = (r.created_at ?? "").slice(0, 7);
    c.set(m, (c.get(m) ?? 0) + 1);
  }
  return [...c.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

console.log(`已重排 ${out.length} 条 → ${target}`);
console.log(`\n前 50 条（pilot 集）月份分布：${coverage(50).map(([m, c]) => `${m}:${c}`).join("  ")}`);
console.log(`\n前 200 条（v1 golden set）月份分布：`);
console.log("  " + coverage(200).map(([m, c]) => `${m}:${c}`).join("  "));
console.log(`\n标注规则：从第 1 条顺序往下标，前 50 条即可跑 pilot，前 200 条为 v1 目标。`);
