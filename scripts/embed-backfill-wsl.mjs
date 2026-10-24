/**
 * 历史 issue 向量回填（WSL 可直接运行的纯 JS 版）：草稿池 JSONL → SiliconFlow bge-m3 → evokeeper.issue_docs
 *
 * 运行（WSL 内，127.0.0.1:5432 才可达 WSL docker 的 pg）：
 *   wsl -e bash -c "cd /mnt/d/git/git_repo03/evokeeper && node scripts/embed-backfill-wsl.mjs"
 *
 * 幂等：ON CONFLICT (repo, issue_number) DO UPDATE。bge-m3 = 1024 维，与表定义匹配。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

// .env.local 装载（容忍等号空格与行内注释）
const envText = readFileSync(resolve(ROOT, ".env.local"), "utf8");
const env = {};
for (const line of envText.split("\n")) {
  const m = /^([A-Z_]+)\s*=\s*([^#]*?)\s*(?:#.*)?$/.exec(line.trim());
  if (m && m[1] && m[2] !== undefined && !process.env[m[1]]) env[m[1]] = m[2];
}
Object.assign(process.env, env);

const DATABASE_URL = process.env.DATABASE_URL;
const SF_KEY = process.env.SILICONFLOW_API_KEY;
const SF_BASE = (process.env.SILICONFLOW_BASE_URL ?? "https://api.siliconflow.cn/v1").replace(/\/+$/, "");
const MODEL = "BAAI/bge-m3";
const BATCH = 16;
const BODY_CHARS = 2000;
const REPLY_CHARS = 600;

if (!DATABASE_URL || !SF_KEY) {
  console.error("缺少 DATABASE_URL 或 SILICONFLOW_API_KEY");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL });

function docText(d) {
  return `${d.title}\n${(d.body_excerpt ?? "").slice(0, 2000)}\n回复摘要: ${(d.replies_excerpt ?? "").slice(0, 600)}`.trim();
}

async function embedBatch(texts) {
  const r = await fetch(`${SF_BASE}/embeddings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SF_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, input: texts }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) throw new Error(`embed ${r.status}: ${(await r.text()).slice(0, 150)}`);
  const j = await r.json();
  return j.data.map((d) => d.embedding);
}

async function main() {
  // 1) 读语料
  const lines = readFileSync(resolve(ROOT, "datasets/drafts/alibaba_nacos.jsonl"), "utf8").trim().split("\n");
  const docs = [];
  const seen = new Set();
  for (const line of lines) {
    const r = JSON.parse(line);
    const num = Number(r.issue_number);
    if (!Number.isInteger(num) || seen.has(num)) continue;
    seen.add(num);
    const replies = (r.maintainer_replies ?? [])
      .map((x) => `${x.author ?? "??"}: ${(x.body_excerpt ?? "").slice(0, 300)}`)
      .join(" | ");
    docs.push({
      repo: String(r.repo ?? "alibaba/nacos"),
      issue_number: num,
      title: String(r.title ?? "").slice(0, 300),
      body: String(r.body_excerpt ?? "").slice(0, 2000),
      replies: replies.slice(0, 600),
      text: `${String(r.title ?? "")}\n${String(r.body_excerpt ?? "").slice(0, 2000)}\n回复摘要: ${replies.slice(0, 600)}`.trim(),
    });
  }
  console.log(`语料: ${docs.length} 条 | 模型: ${MODEL}`);

  // 2) 已回填的跳过（增量，省费用）
  const existing = new Set(
    (await pool.query("SELECT issue_number FROM evokeeper.issue_docs WHERE repo = $1", ["alibaba/nacos"])).rows.map(
      (r) => r.issue_number
    )
  );
  const todo = docs.filter((d) => !existing.has(d.issue_number));
  console.log(`已回填 ${existing.size} 条，本次待回填 ${todo.length} 条`);

  // 3) 批量 embed + upsert
  let done = 0;
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const vectors = await embedBatch(batch.map((d) => d.text));
    for (let k = 0; k < batch.length; k++) {
      const d = batch[k];
      const vec = vectors[k];
      if (!vec || vec.length !== 1024) {
        console.error(`  #${d.issue_number} embedding 维度异常: ${vec?.length}`);
        continue;
      }
      await pool.query(
        `INSERT INTO evokeeper.issue_docs (repo, issue_number, title, body_excerpt, replies_excerpt, embedding)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (repo, issue_number) DO UPDATE SET title=$3, body_excerpt=$4, replies_excerpt=$5, embedding=$6`,
        [d.repo, d.issue_number, d.title, d.body, d.replies, `[${vec.join(",")}]`]
      );
      done++;
    }
    console.log(`  进度 ${Math.min(i + BATCH, todo.length)}/${todo.length}`);
  }
  console.log(`✅ 回填完成: ${done} 条`);
  await pool.end();
}

main().catch((e) => {
  console.error("回填失败:", e.message);
  process.exit(1);
});
