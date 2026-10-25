/**
 * 轨迹重放器（W6 冷启动）—— 把历史 issue 按真实链路灌入，积累整理管线原料
 *
 * 背景：沙盒仓库（自举仓库）真实流量极少，睡眠整理没原料。本脚本把 v1 口径
 * dev 集历史 issue 逐条过 handleIssueEvent（与线上完全同一执行器/提示词/路由），
 * 产出与线上同 schema 的 Trace，落到 datasets/traces/replay-traces.jsonl。
 *
 * 纪律：
 * - 只重放 split=dev（holdout 永不重评，不进任何管线原料）；
 * - 轨迹 id = trace-replay-<gs-id>，天然幂等：中断重跑只补缺失的；
 * - 动作不外发（重放只为轨迹，不碰真实仓库）；
 * - replay 轨迹单独落文件，不与线上 traces.jsonl 混流（scan:daily 语义见其头部注释）。
 *
 * 用法：
 *   pnpm tsx scripts/replay-traces.mts            # 全量 dev（v1 口径）
 *   pnpm tsx scripts/replay-traces.mts --limit=10 # 冒烟
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { handleIssueEvent } from "../apps/agent/src/index";
import { buildTrace, JsonlTraceStore } from "../apps/agent/src/trace-store";
import type { IssueEvent } from "../apps/agent/src/index";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DATA = resolve(ROOT, "datasets/drafts/alibaba_nacos.jsonl");
const OUT_FILE = resolve(ROOT, "datasets/traces/replay-traces.jsonl");

// env 注入（与 scan-daily 同法）
const envText = readFileSync(resolve(ROOT, ".env.local"), "utf8");
for (const line of envText.split("\n")) {
  const m = /^([A-Z_]+)\s*=\s*(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const LIMIT = arg("limit") ? Number(arg("limit")) : Infinity;
const CONCURRENCY = Number(arg("concurrency") ?? 3);

interface GoldenItem {
  id: string;
  repo: string;
  issue_number: number;
  title: string;
  body_excerpt: string | null;
  labels_gold: string[];
  split: string;
}

// ---- 载入 v1 口径 dev 集（与 run-eval 完全同过滤） ----
const allItems = readFileSync(DATA, "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as GoldenItem)
  .filter((it) => it.split === "dev");

let cases = allItems;
const assignmentPath = resolve(ROOT, "datasets/review/v1-assignment.json");
if (existsSync(assignmentPath)) {
  const assignment = JSON.parse(readFileSync(assignmentPath, "utf8")) as {
    v1: { dev: string[]; holdout: string[] };
  };
  const v1Dev = new Set(assignment.v1.dev);
  cases = allItems.filter((it) => v1Dev.has(it.id));
}
console.log(`v1 口径 dev 集：${cases.length} 条（全部 dev ${allItems.length} 条中）`);

// ---- 幂等：跳过已落盘的 ----
const store = new JsonlTraceStore(OUT_FILE);
const done = new Set((await store.all()).map((t) => t.id));
const todo = cases.filter((it) => !done.has(`trace-replay-${it.id}`)).slice(0, LIMIT);
console.log(`已完成 ${done.size}，本次待跑 ${todo.length}`);

// ---- 主标签准确率统计口径（与 eval 一致：主性质标签） ----
const MAIN = new Set(["bug", "feature", "question", "duplicate"]);
const mainOf = (labels: string[]) => labels.find((l) => MAIN.has(l)) ?? labels[0] ?? "invalid";

let match = 0;
let escalated = 0;
let failed = 0;
let cost = 0;
const mismatches: string[] = [];

for (let i = 0; i < todo.length; i += CONCURRENCY) {
  const batch = todo.slice(i, i + CONCURRENCY);
  await Promise.all(
    batch.map(async (it) => {
      const event: IssueEvent = {
        repo: it.repo,
        issueNumber: it.issue_number,
        title: it.title,
        body: it.body_excerpt ?? "",
      };
      try {
        const result = await handleIssueEvent(event);
        const trace = buildTrace(event, result, { id: `trace-replay-${it.id}` });
        await store.append(trace);
        cost += trace.totalCost;
        if (result.escalated || !result.triage) {
          escalated += 1;
          return;
        }
        const got = mainOf(result.triage.labels);
        const want = mainOf(it.labels_gold);
        if (got === want) {
          match += 1;
        } else {
          mismatches.push(`${it.id} #${it.issue_number} ${want}→${got} conf=${result.triage.confidence.toFixed(2)}`);
        }
      } catch (err) {
        failed += 1;
        console.error(`  ✗ ${it.id}: ${String(err).slice(0, 120)}`);
      }
    })
  );
  process.stdout.write(`  progress ${Math.min(i + CONCURRENCY, todo.length)}/${todo.length}\r`);
}

const judged = match + mismatches.length;
console.log("\n==== 重放完成 ====");
console.log(`新增轨迹: ${todo.length - failed}（失败 ${failed}）| 累计成本 ¥${cost.toFixed(4)}`);
if (judged > 0) {
  console.log(`主标签命中: ${match}/${judged} = ${((match / judged) * 100).toFixed(1)}%（escalated ${escalated} 条不计）`);
  console.log(`错分样例（前 8）:\n  ${mismatches.slice(0, 8).join("\n  ")}`);
}
