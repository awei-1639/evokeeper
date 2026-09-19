/**
 * 拉取维护者讨论摘要，嵌进标注界面作为参照（不替标注者下判断）
 *
 * 为什么做：标注者遇到不确定的 issue 时，最可靠的参照是"维护者当时怎么回的"——
 * 维护者是对该 issue 最了解的人类，且这是独立事实，不会污染 golden set。
 * 本脚本只把评论摘要写进 `maintainer_replies` 字段（纯数据），不写任何 labels_gold。
 *
 * token：从 .env.local 或环境变量 GITHUB_TOKEN 读取（不入库、不打印）
 * 用法：
 *   node scripts/fetch-maintainer-replies.mjs          # 默认前 50 条 pilot
 *   node scripts/fetch-maintainer-replies.mjs --all   # 全量 300 条
 *   node scripts/fetch-maintainer-replies.mjs --limit 100
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "datasets", "drafts", "alibaba_nacos.jsonl");

// ---- 读取 token（优先 .env.local，其次环境变量）----
function loadToken() {
  const envPath = path.join(ROOT, ".env.local");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const m = /^GITHUB_TOKEN=(.+)$/.exec(line.trim());
      if (m) return m[1].trim();
    }
  }
  return process.env.GITHUB_TOKEN || "";
}

const TOKEN = loadToken();
if (!TOKEN) {
  console.error("缺少 GITHUB_TOKEN：请写入 .env.local（GITHUB_TOKEN=xxx）或设置环境变量。");
  process.exit(1);
}

// ---- 参数 ----
const args = process.argv.slice(2);
const ALL = args.includes("--all");
const limitArg = args.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? Number(limitArg.split("=")[1]) : 50;

function mask(s) {
  return s
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "<email>")
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, "<token>")
    .replace(/sk-[A-Za-z0-9]{20,}/g, "<token>");
}

function extractComments(body, comments) {
  // 跳过机器人，取前 4 条人类评论做摘要
  const human = comments.filter((c) => (c.user?.type || "User") !== "Bot");
  return human.slice(0, 4).map((c) => ({
    author: c.user?.login || "unknown",
    body_excerpt: mask(String(c.body || "").replace(/\s+/g, " ").trim().slice(0, 240)),
  }));
}

async function fetchComments(repo, number) {
  const url = `https://api.github.com/repos/${repo}/issues/${number}/comments?per_page=100`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "evokeeper-annotate",
    },
  });
  if (res.status === 404) return [];
  if (res.status === 403) throw new Error("403：token 权限不足或触发限额");
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${(await res.text()).slice(0, 120)}`);
  return res.json();
}

async function main() {
  const items = fs
    .readFileSync(DATA, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const targets = ALL ? items : items.slice(0, LIMIT);
  const need = targets.filter((it) => !Array.isArray(it.maintainer_replies));
  console.log(`目标 ${targets.length} 条，其中未拉取 ${need.length} 条`);

  let ok = 0;
  let skipped = 0;
  const CONCURRENCY = 5;
  for (let i = 0; i < need.length; i += CONCURRENCY) {
    const batch = need.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (it) => {
        try {
          const comments = await fetchComments(it.repo, it.issue_number);
          it.maintainer_replies = extractComments(it.body_excerpt, comments);
          ok += 1;
        } catch (e) {
          it.maintainer_replies = [{ author: "fetch-error", body_excerpt: String(e.message || e) }];
          skipped += 1;
        }
      })
    );
    process.stdout.write(`  progress ${Math.min(i + CONCURRENCY, need.length)}/${need.length}\r`);
  }
  console.log(`\n完成：成功 ${ok} 条，失败 ${skipped} 条`);

  const tmp = DATA + ".tmp";
  fs.writeFileSync(tmp, items.map((i) => JSON.stringify(i)).join("\n") + "\n", "utf8");
  fs.renameSync(tmp, DATA);
  console.log(`已写回 ${DATA}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
