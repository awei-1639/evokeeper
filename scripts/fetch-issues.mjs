#!/usr/bin/env node
/**
 * fetch-issues.mjs — golden set 标注草稿池生成器（W1）
 *
 * 用法:
 *   node scripts/fetch-issues.mjs --repo owner/name [--months 12] [--limit 300] [--out datasets/drafts/xxx.jsonl]
 *
 * 行为:
 *   1. 拉取目标仓库已关闭 issue（按创建时间倒序，自动过滤 PR，只保留有回复的）
 *   2. 按创建月份分层、轮转抽样，均匀覆盖时间跨度（标注规范 §4.2 防近期偏差）
 *   3. 正文截断 500 字 + 脱敏（邮箱/手机号），输出标注规范 §5 schema 的草稿行
 *      labels_gold / triage_rationale / difficulty / annotator 留空，由人工标注填写
 *
 * 注意:
 *   - 匿名 GitHub API 限额 60 次/小时（每页 100 条）；配 GITHUB_TOKEN 环境变量可解除。
 *   - 大数据集下 GitHub 强制游标分页（page 参数会 422），本脚本跟随 Link 头 rel="next"。
 *   - 中途某页失败时保留已获取数据继续写盘（best-effort）。
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);
function argOf(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const repo = argOf("--repo");
if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
  console.error('用法: node scripts/fetch-issues.mjs --repo owner/name [--months 12] [--limit 300] [--out path.jsonl]');
  process.exit(1);
}
const months = Number(argOf("--months", "12"));
const limit = Number(argOf("--limit", "300"));
const out = resolve(argOf("--out", `datasets/drafts/${repo.replace("/", "_")}.jsonl`));

const HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": "evokeeper-golden-set-fetcher",
};
if (process.env.GITHUB_TOKEN) {
  HEADERS.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
}

const cutoff = new Date();
cutoff.setMonth(cutoff.getMonth() - months);

function sanitize(text) {
  return text
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "[email]")
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, "[phone]")
    .trim();
}

function truncate(text, max = 500) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function nextLink(linkHeader) {
  if (!linkHeader) return null;
  const m = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return m ? m[1] : null;
}

async function fetchPage(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (res.status === 403 && remaining === "0") {
      throw new Error("GitHub API 限额用尽（60 次/小时），稍后重试或配置 GITHUB_TOKEN");
    }
    throw new Error(`GitHub API ${res.status}: ${(await res.text()).slice(0, 160)}`);
  }
  return { items: await res.json(), next: nextLink(res.headers.get("link")) };
}

const all = [];
let url = `https://api.github.com/repos/${repo}/issues?state=closed&sort=created&direction=desc&per_page=100`;
let page = 0;
const MAX_PAGES = 40;
let stoppedAt = null;

while (url && page < MAX_PAGES) {
  page += 1;
  let items, next;
  try {
    ({ items, next } = await fetchPage(url));
  } catch (e) {
    stoppedAt = `第 ${page} 页拉取失败（保留已获取数据）: ${e.message}`;
    console.warn(`警告: ${stoppedAt}`);
    break;
  }
  for (const it of items) {
    if (it.pull_request) continue;
    if (new Date(it.created_at) < cutoff) continue; // 倒序，越过截止即停
    if (it.comments < 1) continue; // 无回复 ≈ 无结论，标注规范 §4.3
    all.push(it);
  }
  console.log(`page ${page}: 累计候选 ${all.length} 条`);
  const oldest = new Date(items.at(-1)?.created_at ?? 0);
  if (oldest < cutoff) break;
  url = next;
}

if (!all.length) {
  console.error("没有拉到符合条件的 issue（检查仓库名 / months 窗口 / 是否有维护者回复）");
  process.exit(1);
}

// 按月分层 + 轮转抽样（annotation-guideline §4.2：比例接近自然分布、均匀覆盖时间）
const byMonth = new Map();
for (const it of all) {
  const key = it.created_at.slice(0, 7);
  if (!byMonth.has(key)) byMonth.set(key, []);
  byMonth.get(key).push(it);
}
const buckets = [...byMonth.values()];
const picked = [];
for (let i = 0; picked.length < limit; i++) {
  const round = buckets.filter((b) => b.length > 0);
  if (!round.length) break;
  for (const b of round) {
    if (picked.length >= limit) break;
    picked.push(b.shift());
  }
}
picked.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

const lines = picked.map((it) =>
  JSON.stringify({
    id: "TBD",
    repo,
    issue_number: it.number,
    title: it.title,
    body_excerpt: truncate(sanitize(it.body ?? "")),
    labels_gold: [],
    triage_rationale: "",
    qa: null,
    difficulty: "",
    split: "dev",
    annotator: "",
    annotated_at: "",
    // 以下为标注辅助字段，正式定稿时可删除
    url: it.html_url,
    raw_labels: it.labels.map((l) => (typeof l === "string" ? l : l.name)),
    comments_count: it.comments,
    created_at: it.created_at.slice(0, 10),
    closed_at: (it.closed_at ?? "").slice(0, 10),
  }),
);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, lines.join("\n") + "\n", "utf8");

console.log(`\n完成: ${lines.length} 条草稿 → ${out}`);
console.log(`覆盖月份: ${[...byMonth.keys()].sort().join(", ")}`);
console.log(`API 剩余额度: ${HEADERS["Authorization"] ? "token 模式" : "匿名（60/小时）"}`);
if (stoppedAt) console.log(`注意: ${stoppedAt}`);
console.log("下一步: 打开每条的 url 阅读维护者回复, 填写 labels_gold / triage_rationale / qa / difficulty / annotator");
