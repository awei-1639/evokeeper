/**
 * 历史 issue 向量回填（W4）：草稿池 JSONL → embed → evokeeper.issue_docs
 *
 * 用法（峰谷纪律：批量 embedding 排 22:00-次日 08:00 或周末，design.md §9.1）：
 *   DATABASE_URL=postgresql://... pnpm tsx scripts/embed-backfill.mts
 *
 * 幂等：upsert by (repo, issue_number)，可重复执行；已回填的条目 --skip-existing 可跳过
 * （增量模式，省 embed 费用）。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { createLlm } from "../packages/llm/src/index";
import { PgIssueDocsStore, type IssueDocRow } from "../apps/agent/src/pg/issue-docs-pg";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

// 与 run-eval.mts 相同的 .env.local 装载方式
const envText = readFileSync(resolve(ROOT, ".env.local"), "utf8");
for (const line of envText.split("\n")) {
  const m = /^([A-Z_]+)\s*=\s*([^#]*?)\s*(?:#.*)?$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const DATA = process.env.BACKFILL_DATA ?? resolve(ROOT, "datasets/drafts/alibaba_nacos.jsonl");
const BATCH_SIZE = 16; // 批内一次 embed 请求的条数
const BODY_CHARS = 2000; // 参与 embed 的正文摘录上限（embed 8192 token 足够）
const argv = process.argv.slice(2);
const SKIP_EXISTING = argv.includes("--skip-existing");
const DRY_RUN = argv.includes("--dry-run");

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("缺少 DATABASE_URL");
    process.exit(1);
  }
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error("缺少 DEEPSEEK_API_KEY");
    process.exit(1);
  }

  const lines = readFileSync(DATA, "utf8").trim().split("\n");
  const seen = new Set<number>();
  const docs: Array<{ issueNumber: number; title: string; body: string; replies: string }> = [];
  for (const line of lines) {
    const r = JSON.parse(line) as Record<string, unknown>;
    const num = Number(r["issue_number"]);
    if (!Number.isInteger(num) || seen.has(num)) continue;
    seen.add(num);
    const replies = (Array.isArray(r["maintainer_replies"]) ? r["maintainer_replies"] : [])
      .map((x) => x as { author?: string; body_excerpt?: string })
      .filter((x) => x.author !== "fetch-error" && typeof x.body_excerpt === "string")
      .map((x) => `${x.author}: ${x.body_excerpt}`)
      .join(" | ");
    docs.push({
      issueNumber: num,
      title: typeof r["title"] === "string" ? (r["title"] as string) : "",
      body: typeof r["body_excerpt"] === "string" ? (r["body_excerpt"] as string) : "",
      replies,
    });
  }
  const repo = typeof docs[0] !== "undefined" ? "alibaba/nacos" : "";
  console.log(`语料 ${docs.length} 条（来自 ${DATA}），repo=${repo}，skip-existing=${SKIP_EXISTING}`);

  const pool = new Pool({
    connectionString,
    // search_path 指向业务 schema（与 PgMemoryStore 同约定）
    options: "-c search_path=evokeeper,public",
    max: 2,
  });
  const store = new PgIssueDocsStore(pool);
  const existing = await store.count();
  console.log(`已回填 ${existing} 条`);

  const llm = createLlm();
  const embedModel = "text-embedding-v4";
  let done = 0;
  let skipped = 0;
  let totalTokens = 0;
  const existingNumbers = new Set<number>();
  if (SKIP_EXISTING) {
    const r = await pool.query<{ issue_number: number }>(
      "SELECT issue_number FROM evokeeper.issue_docs WHERE repo = $1",
      [repo]
    );
    for (const row of r.rows) existingNumbers.add(Number(row.issue_number));
  }

  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = docs.slice(i, i + BATCH_SIZE).filter((d) => {
      if (SKIP_EXISTING && existingNumbers.has(d.issueNumber)) {
        skipped++;
        return false;
      }
      return true;
    });
    if (batch.length === 0) continue;

    const texts = batch.map(
      (d) => `${d.title}\n${d.body.slice(0, BODY_CHARS)}${d.replies ? `\n${d.replies.slice(0, 800)}` : ""}`
    );
    const embedded = await llm.embed(texts);
    totalTokens += embedded.inputTokens;
    const rows: IssueDocRow[] = batch.map((d, idx) => ({
      repo,
      issueNumber: d.issueNumber,
      title: d.title,
      bodyExcerpt: d.body.slice(0, BODY_CHARS),
      repliesExcerpt: d.replies.slice(0, 800),
      embedding: embedded.vectors[idx] ?? [],
    }));
    if (!DRY_RUN) await store.upsertBatch(rows);
    done += batch.length;
    process.stdout.write(
      `\r  进度 ${done + skipped}/${docs.length}（本批 ${batch.length}，token 累计 ${totalTokens}）`
    );
  }
  console.log(
    `\n完成：新回填 ${done}，跳过 ${skipped}，总 token ${totalTokens}（≈¥${((totalTokens / 1_000_000) * 0.5).toFixed(4)}）`
  );
  const finalCount = await store.count();
  console.log(`issue_docs 现有 ${finalCount} 条`);
  await pool.end();
}

main().catch((err: unknown) => {
  console.error("\n回填失败：", err);
  process.exit(1);
});
