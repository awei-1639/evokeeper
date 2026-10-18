/**
 * duplicate 召回探针（W4）—— tp-1.3 检索证据注入的定向对照实验
 *
 * 背景：tp-1.2 dev 基线 duplicate 召回 0/19（design.md §9.1 定性为"判重需跨 issue
 * 证据，静态分诊不可得"）。本探针只跑 duplicate gold + 非重复对照组，
 * 快速验证 <similar_issues> 注入后的召回提升与误报变化，不产生正式 EvalRun。
 *
 * 用法（需先 embed-backfill 回填向量库）：
 *   DATABASE_URL=... pnpm tsx scripts/dup-recall-probe.mts [--nondup=20] [--delay-ms=30000]
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { createLlm } from "../packages/llm/src/index";
import { loadGoldenSet } from "../packages/eval/src/index";
import { handleIssueEvent, type IssueEvent } from "../apps/agent/src/index";
import { createSimilarIssuesSearch } from "../apps/agent/src/similar-issues";
import { PgIssueDocsStore } from "../apps/agent/src/pg/issue-docs-pg";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const envText = readFileSync(resolve(ROOT, ".env.local"), "utf8");
for (const line of envText.split("\n")) {
  const m = /^([A-Z_]+)\s*=\s*([^#]*?)\s*(?:#.*)?$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const NONDUP_N = arg("nondup") ? Number(arg("nondup")) : 20;
const DELAY_MS = arg("delay-ms") ? Number(arg("delay-ms")) : 30_000;

function mainLabelOf(labels: string[]): string | null {
  const mains = labels.filter((l) => ["bug", "feature", "question", "duplicate"].includes(l));
  return mains[0] ?? (labels.includes("invalid") ? "invalid" : null);
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("缺少 DATABASE_URL");
    process.exit(1);
  }
  const pool = new Pool({ connectionString, options: "-c search_path=evokeeper,public", max: 2 });
  const store = new PgIssueDocsStore(pool);
  const docs = await store.count();
  if (docs === 0) {
    console.error("向量库为空：先跑 embed-backfill.mts");
    process.exit(1);
  }

  const all = loadGoldenSet(resolve(ROOT, "datasets/drafts/alibaba_nacos.jsonl"), { split: "dev" });
  // v1 口径过滤（与 run-eval 同纪律）
  const assignPath = resolve(ROOT, "datasets/review/v1-assignment.json");
  const v1Ids =
    existsSync(assignPath)
      ? new Set(
          (JSON.parse(readFileSync(assignPath, "utf8")) as { v1: { dev: string[] } }).v1.dev
        )
      : null;
  const cases = (v1Ids ? all.filter((c) => v1Ids.has(c.id)) : all).filter(
    (c) => c.goldMain !== null
  );
  const dupGold = cases.filter((c) => c.goldMain === "duplicate");
  const nonDup = cases.filter((c) => c.goldMain !== "duplicate");
  // 对照组均匀取样（保持 gold 分布，避免全取 rare 类）
  const step = Math.max(1, Math.floor(nonDup.length / NONDUP_N));
  const nonDupSample = nonDup.filter((_, i) => i % step === 0).slice(0, NONDUP_N);
  console.log(
    `dev v1: ${cases.length} 条 | duplicate gold ${dupGold.length} 条 | 对照组取样 ${nonDupSample.length} 条 | 向量库 ${docs} 条`
  );

  const llm = createLlm();
  const similarSearch = createSimilarIssuesSearch({ llm, store });
  const searchWrapper = { search: similarSearch.search.bind(similarSearch), model: similarSearch.model };

  let dupHit = 0;
  let citedTotal = 0;
  let fpCount = 0;
  const lines: string[] = [];

  const run = async (c: (typeof cases)[number], isDupGold: boolean): Promise<void> => {
    const event: IssueEvent = {
      repo: c.repo,
      issueNumber: c.issueNumber,
      title: c.title,
      body: c.bodyExcerpt,
    };
    const res = await handleIssueEvent(event, { llm, similarSearch: searchWrapper });
    const pred = res.triage ? mainLabelOf(res.triage.labels) : null;
    const cited = res.triage ? (/ #(\d+)/.exec(res.triage.rationale)?.[1] ?? null) : null;
    const hitsSummary = res.steps[0]?.toolSummary ?? "no-search";
    if (isDupGold && pred === "duplicate") dupHit++;
    if (cited) citedTotal++; // 引用号合法性由 decideActions 护栏保证（无证据编号自动降级，agent.test.ts 已锁）
    if (!isDupGold && pred === "duplicate") fpCount++;
    const mark = isDupGold ? (pred === "duplicate" ? "✓" : "✗") : pred === "duplicate" ? "⚠FP" : ".";
    lines.push(
      `${mark} ${c.id} gold=${c.goldMain} pred=${pred} cited=${cited ? `#${cited}` : "-"} [${hitsSummary}] ${res.triage?.rationale.slice(0, 60) ?? ""}`
    );
  };

  let called = 0;
  for (const c of dupGold) {
    if (called > 0) await new Promise((r) => setTimeout(r, DELAY_MS));
    called++;
    await run(c, true);
    process.stdout.write(`\r已跑 ${called}/${dupGold.length + nonDupSample.length}`);
  }
  for (const c of nonDupSample) {
    if (called > 0) await new Promise((r) => setTimeout(r, DELAY_MS));
    called++;
    await run(c, false);
    process.stdout.write(`\r已跑 ${called}/${dupGold.length + nonDupSample.length}`);
  }

  console.log("\n\n== 探针结果 ==");
  for (const l of lines) console.log(l);
  console.log(
    `\nduplicate 召回: ${dupHit}/${dupGold.length}（tp-1.2 基线 0/19）\n对照组误报 duplicate: ${fpCount}/${nonDupSample.length}\n引用编号输出: ${citedTotal} 次（全部经动作层护栏校验）\n成本提示：详见各步 costAmount`
  );
  await pool.end();
}

main().catch((err: unknown) => {
  console.error("探针失败：", err);
  process.exit(1);
});
