#!/usr/bin/env node
// Cohen's κ 计算器 —— 第 1 轮（ai-v1，主数据文件）vs 第 2 轮盲标（annotator=v2）
// 用法：node scripts/kappa.mjs <round2.jsonl>
//   round2.jsonl 是盲标子集经标注工具（ANNOTATE_DATA=datasets/review/blind-round2.jsonl node scripts/annotate.mjs）
//   标完后落盘的文件：每行含 issue_number + labels_gold + annotator（工具保存时写 v2）。
// 输出：主标签一致率、Cohen's κ（未加权）、逐类混淆矩阵、不一致清单（供逐条仲裁）。
// 判定标准见 docs/annotation-guideline.md §7：κ ≥ 0.75 达标；< 0.6 先修标签定义再硬标。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MAIN = ['bug', 'feature', 'question', 'duplicate', 'invalid'];
const GOLD_THRESHOLD = 0.75;
const REWORK_THRESHOLD = 0.6;

const round2Path = process.argv[2] || path.join(ROOT, 'datasets', 'review', 'blind-round2.jsonl');
const round1Path = process.env.ANNOTATE_GOLD || path.join(ROOT, 'datasets', 'drafts', 'alibaba_nacos.jsonl');

function readJsonl(p) {
  return fs
    .readFileSync(p, 'utf8')
    .trim()
    .split('\n')
    .map((l, i) => {
      try {
        return JSON.parse(l);
      } catch {
        throw new Error(`${p} 第 ${i + 1} 行不是合法 JSON`);
      }
    });
}

const mainOf = (r) => (r.labels_gold || []).find((l) => MAIN.includes(l)) || null;

const r1 = readJsonl(round1Path).filter((r) => r.annotator === 'ai-v1');
const r2raw = readJsonl(round2Path);
const r2 = r2raw.filter((r) => Array.isArray(r.labels_gold) && r.labels_gold.length > 0);

if (r2.length === 0) {
  console.error('round2 文件里还没有任何标注（labels_gold 全为空）。');
  console.error('请先运行：ANNOTATE_DATA=datasets/review/blind-round2.jsonl node scripts/annotate.mjs  →  http://localhost:8765 盲标。');
  process.exit(1);
}
if (r2.length < r2raw.length) {
  console.warn(`提示：round2 共 ${r2raw.length} 条，已标注 ${r2.length} 条，仅计算已标注部分。\n`);
}

const r1ByNum = new Map(r1.map((r) => [r.issue_number, r]));
const pairs = [];
for (const b of r2) {
  const a = r1ByNum.get(b.issue_number);
  if (!a) {
    console.warn(`跳过 #${b.issue_number}：第 1 轮数据中找不到`);
    continue;
  }
  pairs.push({ issue_number: b.issue_number, id: a.id, l1: mainOf(a), l2: mainOf(b) });
}

// 混淆矩阵 + κ
const labels = [...new Set(pairs.flatMap((p) => [p.l1, p.l2]).filter(Boolean))].sort();
const M = Object.fromEntries(labels.map((a) => [a, Object.fromEntries(labels.map((b) => [b, 0]))]));
for (const p of pairs) M[p.l1][p.l2] += 1;

const n = pairs.length;
const agree = pairs.filter((p) => p.l1 === p.l2).length;
const po = agree / n;
const pe = labels.reduce((s, a) => {
  const row = pairs.filter((p) => p.l1 === a).length / n;
  const col = pairs.filter((p) => p.l2 === a).length / n;
  return s + row * col;
}, 0);
const kappa = pe === 1 ? 1 : (po - pe) / (1 - pe);

console.log(`样本：${n} 条（第 1 轮 annotator=ai-v1 vs 第 2 轮盲标 annotator=${r2[0].annotator || 'v2'}）`);
console.log(`一致率 po = ${(po * 100).toFixed(1)}% （${agree}/${n}）`);
console.log(`期望一致率 pe = ${(pe * 100).toFixed(1)}%`);
console.log(`Cohen's κ = ${kappa.toFixed(3)}`);
console.log(
  kappa >= GOLD_THRESHOLD
    ? `✅ κ ≥ ${GOLD_THRESHOLD}，达标（guideline §7）`
    : kappa >= REWORK_THRESHOLD
      ? `⚠️ κ ∈ [${REWORK_THRESHOLD}, ${GOLD_THRESHOLD})，未达标：优先逐条仲裁不一致样本，必要时修订标签边界定义`
      : `❌ κ < ${REWORK_THRESHOLD}：按 guideline §7 应先修标签定义，不要硬标`
);
console.log('\n混淆矩阵（行=第1轮 ai-v1，列=第2轮）：');
const w = Math.max(...labels.map((l) => l.length)) + 2;
console.log(' '.repeat(w) + labels.map((l) => l.padStart(w - 1)).join(''));
for (const a of labels) {
  console.log(a.padEnd(w) + labels.map((b) => String(M[a][b]).padStart(w - 1)).join(''));
}

const disputes = pairs.filter((p) => p.l1 !== p.l2);
if (disputes.length) {
  console.log(`\n不一致清单（${disputes.length} 条，供仲裁，仲裁理由写入主文件 triage_rationale）：`);
  for (const d of disputes) console.log(`  ${d.id} #${d.issue_number}: ai-v1=${d.l1}  round2=${d.l2}`);
}
