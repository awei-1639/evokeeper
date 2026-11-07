/**
 * 解析失败根因探针：对指定 case 走真实 triage 通道，落原始输出 + 校验错误。
 * 用途：失败重试 3 次仍不过的 case 到底是「空 labels」「格式跑偏」还是「拒绝回答」，
 * 只有看到 raw 才能判定是加修复轮次还是改 schema。
 * 用法：pnpm tsx scripts/parse-fail-probe.mts --cases=gs-0054,gs-0102 [--raw]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLlm, resolveModel } from "../packages/llm/src/index";
import { DEFAULT_MODEL_CONFIG } from "../packages/llm/src/config";
import { buildTriageMessages, parseTriage } from "../apps/agent/src/triage";
import { loadGoldenSet, mainLabelOf } from "../packages/eval/src/index";
import { extractJson } from "../packages/llm/src/structured";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const envText = readFileSync(resolve(ROOT, ".env.local"), "utf8");
for (const line of envText.split("\n")) {
  const m = /^([A-Z_]+)\s*=\s*([^#]*?)\s*(?:#.*)?$/.exec(line.trim());
  if (m && m[1] && m[2] !== undefined && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const argv = process.argv.slice(2);
const explicit = (argv.find((a) => a.startsWith("--cases="))?.split("=")[1] ?? "").split(",").filter(Boolean);
const spFile = argv.find((a) => a.startsWith("--system-prompt-file="))?.split("=")[1];
const controlN = Number(argv.find((a) => a.startsWith("--control="))?.split("=")[1] ?? 0);

const cases = loadGoldenSet(resolve(ROOT, "datasets/drafts/alibaba_nacos.jsonl"), { split: "dev" });
const byId = new Map(cases.map((c) => [c.id, c]));

// 对照组：等距抽样，用来验证提示词改动没有伤到原本判对的 case
const controlIds: string[] = [];
if (controlN > 0) {
  const stride = Math.max(1, Math.floor(cases.length / controlN));
  for (let i = 0; i < cases.length && controlIds.length < controlN; i += stride) {
    const c = cases[i]!;
    if (!explicit.includes(c.id)) controlIds.push(c.id);
  }
}
const ids = [...explicit, ...controlIds];
if (ids.length === 0) {
  console.error("需要 --cases=gs-xxxx,gs-yyyy 或 --control=N");
  process.exit(1);
}

const llm = createLlm({ config: DEFAULT_MODEL_CONFIG, cache: null });
const model = resolveModel("triage", DEFAULT_MODEL_CONFIG);
const systemOverride = spFile ? readFileSync(resolve(ROOT, spFile), "utf8") : null;
if (systemOverride) console.log(`系统提示词覆盖: ${spFile}（${systemOverride.length} 字）`);

const outDir = resolve(ROOT, "datasets/eval/.probe");
mkdirSync(outDir, { recursive: true });
const records: Array<Record<string, unknown>> = [];

for (const id of ids) {
  const c = byId.get(id);
  if (!c) {
    console.log(`${id} 不在 dev 集中`);
    continue;
  }
  // 关缓存：要的是这次真实输出，不能命中历史
  const { system, user } = buildTriageMessages(
    { repo: c.repo, issueNumber: c.issueNumber, title: c.title, body: c.bodyExcerpt } as never,
    systemOverride ? { systemOverride } : {}
  );

  const res = await llm.json({
    purpose: "triage",
    system,
    user,
    validate: parseTriage,
  });
  const raw = res.raw;
  const extracted = extractJson(raw);
  const check = res.ok
    ? ({ ok: true as const, value: res.data! } as const)
    : ({ ok: false as const, error: res.error ?? "未知错误" } as const);
  records.push({
    caseId: id,
    group: controlIds.includes(id) ? "control" : "target",
    goldMain: c.goldMain,
    model,
    raw,
    extracted,
    ok: check.ok,
    error: check.ok ? null : check.error,
    predMain: check.ok ? mainLabelOf(check.value.labels) : null,
    confidence: check.ok ? check.value.confidence : null,
    attempts: res.meta.attempts,
    repairTurns: res.meta.repairTurns,
    costAmount: res.meta.costAmount,
    contentLength: raw.length,
  });
  console.log(
    `=== ${id}  gold=${c.goldMain}  ok=${check.ok}  attempts=${res.meta.attempts} repair=${res.meta.repairTurns} ¥${res.meta.costAmount.toFixed(5)}`
  );
  if (!check.ok) console.log(`  error: ${check.error}`);
  console.log("  raw: " + raw.replace(/\s+/g, " ").slice(0, 220));
}

const outFile = resolve(outDir, `parse-fail-${Date.now()}.json`);
writeFileSync(outFile, JSON.stringify(records, null, 2), "utf8");

// 小结：目标组（原本判死）恢复率 + 对照组（原本判对）有没有被打坏
const base = JSON.parse(
  readFileSync(resolve(ROOT, "datasets/eval/run-aq-base-dev-amd-deepseek-v4-flash-mc-1.4-v2.json"), "utf8")
) as { perCaseDetail: Array<{ caseId: string; goldMain: string; predMain: string | null }> };
const before = new Map(base.perCaseDetail.map((c) => [c.caseId, c.predMain]));
const stat = (group: string) => {
  const g = records.filter((r) => r.group === group);
  if (g.length === 0) return null;
  const okBefore = g.filter((r) => before.get(String(r.caseId)) === r.goldMain).length;
  const okAfter = g.filter((r) => r.predMain === r.goldMain).length;
  const nullBefore = g.filter((r) => before.get(String(r.caseId)) === null).length;
  const nullAfter = g.filter((r) => r.predMain === null).length;
  return { n: g.length, okBefore, okAfter, nullBefore, nullAfter };
};
const t = stat("target");
const ctl = stat("control");
if (t) console.log(`\n[目标组] n=${t.n}  判对 ${t.okBefore}→${t.okAfter}  判死 ${t.nullBefore}→${t.nullAfter}`);
if (ctl) console.log(`[对照组] n=${ctl.n}  判对 ${ctl.okBefore}→${ctl.okAfter}  判死 ${ctl.nullBefore}→${ctl.nullAfter}`);
console.log(`已落盘: ${outFile}`);
