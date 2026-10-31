/**
 * duplicate 阈值探针：纯相似度规则能否替代「prompt 注入证据」？
 *
 * 背景（2026-10-31 混淆矩阵）：v2 dev 上 duplicate 召回 **0/16**，且方向单一（只漏不误），
 * 一条就占全部错误的 24.6%。此前两条修法都因成本被门禁否掉（注入 5×400 字证据 +145%、
 * BM25 轻量证据持平）——根因是「把证据塞进 prompt 让模型自己判」，输入 token 撑爆成本预算。
 *
 * 本探针验证另一条路：**把判定从 prompt 文本搬进决策层**——只用向量相似度做阈值判定
 * （经验形态 = 一个阈值参数，不是一段文字）。成本增量 ≈ 一次向量检索（embed 已在库，
 * Linux 侧无 LLM 调用），若可分性成立，这是成本纪律下唯一能过大效应量的路线。
 *
 * 零 LLM 成本：只读 pg 里的现成向量。
 *
 * 用法：pnpm exec tsx scripts/dup-threshold-probe.mts
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { loadGoldenSet } from "../packages/eval/src/index";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

for (const line of readFileSync(resolve(ROOT, ".env.local"), "utf8").split("\n")) {
  const m = /^([A-Z_]+)\s*=\s*(.+)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const DB = process.env.DATABASE_URL;
if (!DB) {
  console.error("缺少 DATABASE_URL");
  process.exit(1);
}

const RUN = "run-v2-tp14d2-dev-deepseek-v4-flash-mc-1.0-v2.json";
const runJson = JSON.parse(
  readFileSync(resolve(ROOT, "datasets/eval", RUN), "utf8")
) as { perCaseDetail: Array<{ caseId: string; goldMain: string }> };

const golden = new Map(
  loadGoldenSet(resolve(ROOT, "datasets/drafts/alibaba_nacos.jsonl")).map((g) => [g.id, g])
);
const goldByNumber = new Map(
  [...golden.values()].map((g) => [`${g.repo}#${g.issueNumber}`, g.goldMain])
);

const cases = runJson.perCaseDetail
  .map((d) => ({ ...d, g: golden.get(d.caseId) }))
  .filter((d): d is typeof d & { g: NonNullable<typeof d.g> } => d.g !== undefined && d.g.repo !== "");

console.log(`样本 ${cases.length} 条 dev（基线 ${RUN}），向量库 alibaba/nacos`);

const pool = new Pool({ connectionString: DB });
const client = await pool.connect();
try {
  // 自连接取 top-5 相似（排除自身）——与线上 similar-issues 的检索口径一致
  const SQL = `
    SELECT d.issue_number AS num,
           d.title AS title,
           1 - (d.embedding <=> s.embedding) AS sim
    FROM evokeeper.issue_docs s
    JOIN evokeeper.issue_docs d
      ON d.repo = s.repo AND d.issue_number <> s.issue_number
    WHERE s.repo = $1 AND s.issue_number = $2
    ORDER BY d.embedding <=> s.embedding
    LIMIT 5
  `;

  interface Row {
    caseId: string;
    gold: string;
    top1: number;
    top1Num: number;
    top1Gold: string | null;
  }
  const rows: Row[] = [];
  for (const c of cases) {
    const r = await client.query<{ num: number; title: string; sim: number }>(SQL, [
      c.g.repo,
      c.g.issueNumber,
    ]);
    const first = r.rows[0];
    if (!first) continue;
    rows.push({
      caseId: c.caseId,
      gold: c.goldMain,
      top1: Number(first.sim),
      top1Num: first.num,
      top1Gold: goldByNumber.get(`${c.g.repo}#${first.num}`) ?? null,
    });
  }

  // ---- 1. 按 gold 标签看 top1 相似度分布 ----
  const groups = new Map<string, number[]>();
  for (const r of rows) {
    const arr = groups.get(r.gold) ?? [];
    arr.push(r.top1);
    groups.set(r.gold, arr);
  }
  const q = (arr: number[], p: number): number => {
    if (arr.length === 0) return NaN;
    const s = [...arr].sort((a, b) => a - b);
    const i = Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)));
    return s[i] ?? NaN;
  };
  console.log(`\n=== top-1 相似度分布（按 gold 主标签）===`);
  console.log(`label      n    min    p25    med    p75    max`);
  for (const [label, arr] of [...groups.entries()].sort()) {
    console.log(
      `${label.padEnd(10)} ${String(arr.length).padStart(3)}  ${q(arr, 0).toFixed(3)}  ${q(arr, 0.25).toFixed(3)}  ${q(arr, 0.5).toFixed(3)}  ${q(arr, 0.75).toFixed(3)}  ${q(arr, 1).toFixed(3)}`
    );
  }

  // ---- 2. 阈值扫描：sim >= τ 判 duplicate ----
  console.log(`\n=== 阈值扫描（sim ≥ τ → 判 duplicate）===`);
  console.log(`τ      TP  FP  FN   precision  recall   F1    判定数`);
  const dupTotal = rows.filter((r) => r.gold === "duplicate").length;
  let best: { tau: number; f1: number; p: number; r: number } | null = null;
  for (let t = 70; t <= 95; t++) {
    const tau = t / 100;
    let tp = 0;
    let fp = 0;
    let decided = 0;
    for (const r of rows) {
      if (r.top1 >= tau) {
        decided++;
        if (r.gold === "duplicate") tp++;
        else fp++;
      }
    }
    const fn = dupTotal - tp;
    const p = tp + fp > 0 ? tp / (tp + fp) : 0;
    const rec = dupTotal > 0 ? tp / dupTotal : 0;
    const f1 = p + rec > 0 ? (2 * p * rec) / (p + rec) : 0;
    if (f1 > (best?.f1 ?? 0)) best = { tau, f1, p, r: rec };
    console.log(
      `${tau.toFixed(2)}   ${String(tp).padStart(2)}  ${String(fp).padStart(2)}  ${String(fn).padStart(2)}   ${p.toFixed(3)}      ${rec.toFixed(3)}    ${f1.toFixed(3)}  ${decided}`
    );
  }
  console.log(
    best
      ? `\n最优 F1 = ${best.f1.toFixed(3)} @ τ=${best.tau.toFixed(2)}（precision ${best.p.toFixed(3)} / recall ${best.r.toFixed(3)}）；duplicate 共 ${dupTotal} 条`
      : "\n无可行阈值"
  );

  // ---- 3. 误报画像：被判 duplicate 的非 duplicate 长什么样 ----
  const fpCases = rows.filter((r) => r.gold !== "duplicate" && r.top1 >= (best?.tau ?? 0.9));
  if (fpCases.length > 0) {
    console.log(`\n=== τ 处误报 ${fpCases.length} 条（top-1 相似度高但 gold 非 duplicate）===`);
    for (const r of fpCases.slice(0, 8)) {
      console.log(
        `  ${r.caseId} gold=${r.gold.padEnd(9)} sim=${r.top1.toFixed(3)} → #${r.top1Num}(gold=${r.top1Gold ?? "?"})`
      );
    }
  }
} finally {
  client.release();
  await pool.end();
}
