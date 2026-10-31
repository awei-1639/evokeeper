/**
 * 采样分歧探针：k 次多数投票降噪是否可行（design.md §7.2 统计功效三选一的方案②）
 *
 * 问题：当前 triage 温度 = 0（structured.ts 默认），同一 case 多次调用几乎必然同结果，
 * 那么「采样 k 次取多数」就是纯浪费钱。必须先回答：**换个温度，模型真的会分歧吗？**
 *
 * 判据（跑完看这两个数）：
 *   - 分歧率 < 5%  → 多数投票无效，方案② 直接毙掉
 *   - 分歧率 15~40% 且「错例被多数票修正」显著多于「对例被改坏」→ 方案② 成立，值得全量铺
 *
 * 成本可控：默认错例/对例各 12 条 × k=5，约 ¥0.2 量级。cache 必须关（triage TTL 24h，
 * 否则 k 次采样全命中同一条缓存，测出来的分歧率恒为 0——这是本探针最容易踩的坑）。
 *
 * 用法：
 *   pnpm exec tsx scripts/sampling-probe.mts
 *   pnpm exec tsx scripts/sampling-probe.mts --k=7 --temp=1.0 --limit=40
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLlm, DEFAULT_MODEL_CONFIG } from "../packages/llm/src/index";
import { buildTriageMessages, parseTriage, type IssueEvent } from "../apps/agent/src/index";
import { loadGoldenSet, mainLabelOf } from "../packages/eval/src/index";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---- 环境 ----
try {
  for (const line of readFileSync(resolve(ROOT, ".env.local"), "utf8").split("\n")) {
    const m = /^([A-Z_]+)\s*=\s*([^#]*?)\s*(?:#.*)?$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch {
  console.error("读取 .env.local 失败");
  process.exit(1);
}
if (!process.env.DEEPSEEK_API_KEY) {
  console.error("缺少 DEEPSEEK_API_KEY");
  process.exit(1);
}

// ---- 参数 ----
const argv = process.argv.slice(2);
const arg = (name: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const K = Number(arg("k") ?? 5);
const TEMP = Number(arg("temp") ?? 0.8);
const LIMIT = Number(arg("limit") ?? 24); // 错例/对例各取一半
const DELAY_MS = Number(arg("delay-ms") ?? 0);
const BASELINE_RUN = arg("run") ?? "run-v2-tp14d2-dev-deepseek-v4-flash-mc-1.0-v2.json";

// ---- 选样：优先「当前错例」，并取等量「当前对例」做对照 ----
interface Detail {
  caseId: string;
  goldMain: string;
  predMain: string | null;
}
const runJson = JSON.parse(
  readFileSync(resolve(ROOT, "datasets/eval", BASELINE_RUN), "utf8")
) as { perCaseDetail: Detail[] };
const perCase = runJson.perCaseDetail;

const golden = new Map(
  loadGoldenSet(resolve(ROOT, "datasets/drafts/alibaba_nacos.jsonl")).map((g) => [g.id, g])
);
const wrong: Detail[] = [];
const right: Detail[] = [];
for (const d of perCase) {
  if (!golden.has(d.caseId)) continue;
  if (d.predMain === d.goldMain) right.push(d);
  else wrong.push(d);
}
const half = Math.max(1, Math.floor(LIMIT / 2));
const picked = [...wrong.slice(0, half), ...right.slice(0, half)];
console.log(
  `样本：错例 ${Math.min(half, wrong.length)} + 对例 ${Math.min(half, right.length)} = ${picked.length} 条 | k=${K} temp=${TEMP} | 基线 ${BASELINE_RUN}`
);

// ---- 采样（cache=null：否则 k 次全命中缓存）----
const llm = createLlm({ cache: null });

interface CaseProbe {
  caseId: string;
  goldMain: string;
  baselinePred: string | null;
  samples: string[];
  distinct: number;
  /** 多数票（平票记 tie） */
  majority: string | null;
  tie: boolean;
  cost: number;
}

const probes: CaseProbe[] = [];
let called = 0;
for (const d of picked) {
  const g = golden.get(d.caseId);
  if (!g) continue;
  const event: IssueEvent = {
    repo: g.repo,
    issueNumber: g.issueNumber,
    title: g.title,
    body: g.bodyExcerpt,
  };
  const { system, user } = buildTriageMessages(event);
  const samples: string[] = [];
  const errSamples: string[] = [];
  let cost = 0;
  for (let i = 0; i < K; i++) {
    if (DELAY_MS > 0 && called > 0) await new Promise((r) => setTimeout(r, DELAY_MS));
    called++;
    const res = await llm.json({
      purpose: "triage",
      system,
      user,
      temperature: TEMP,
      validate: parseTriage,
    });
    cost += res.meta.costAmount;
    if (!res.ok) {
      errSamples.push(res.error ?? "unknown");
    }
    samples.push(res.ok && res.data ? mainLabelOf(res.data.labels) : "PARSE_FAIL");
  }
  const counts = new Map<string, number>();
  for (const s of samples) counts.set(s, (counts.get(s) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  const second = ranked[1];
  const tie = ranked.length > 1 && second !== undefined && second[1] === top?.[1];
  probes.push({
    caseId: d.caseId,
    goldMain: d.goldMain,
    baselinePred: d.predMain,
    samples,
    distinct: counts.size,
    majority: tie ? null : (top?.[0] ?? null),
    tie,
    cost,
  });
  const flag = tie ? "tie" : (top?.[0] ?? "?");
  console.log(
    `  ${d.caseId} gold=${d.goldMain.padEnd(9)} 基线=${(d.predMain ?? "null").padEnd(9)} 采样=[${samples.join(",")}] → ${flag}`
  );
  if (errSamples.length > 0) {
    console.log(`    ⚠ 失败 ${errSamples.length}/${K}：${errSamples[0]?.slice(0, 200)}`);
  }
}

// ---- 统计 ----
const n = probes.length;
// 有效样本 = 至少采到一次成功结果的 case。全失败（402/网络）时绝不能下「分歧率低」的结论，
// 那是把「没跑起来」误读成「模型很稳定」——比不跑更危险。
const valid = probes.filter((p) => p.samples.some((s) => s !== "PARSE_FAIL")).length;
const divergent = probes.filter((p) => p.distinct > 1).length;
const ties = probes.filter((p) => p.tie).length;
const totalCost = probes.reduce((a, p) => a + p.cost, 0);

console.log(`\n=== 结论 ===`);
console.log(`样本 ${n} 条（有效 ${valid}），每条 ${K} 次采样，调用 ${called} 次，成本 ¥${totalCost.toFixed(4)}`);

if (valid === 0 || valid / n < 0.8) {
  console.log(`✗ 数据无效：有效样本 ${valid}/${n}，失败率过高（多为 402 余额/网络/频控）。`);
  console.log(`  本次不下结论——重跑前先确认 DEEPSEEK 余额与通道可用。`);
  process.exitCode = 2;
} else {
  const validProbes = probes.filter((p) => p.samples.some((s) => s !== "PARSE_FAIL"));
  let fixed = 0;
  let broken = 0;
  let keptRight = 0;
  let stillWrong = 0;
  let noVote = 0;
  // 采样真正的功劳只能算在「有分歧」的 case 上：无分歧却与基线预测不同，
  // 那是换了通道/版本造成的差异，跟多数投票无关（2026-10-31 误判过一次，故显式分开记）。
  let divFixed = 0;
  let divBroken = 0;
  let channelDiff = 0;
  let accSingle = 0;
  let accMajor = 0;
  for (const p of validProbes) {
    const baseRight = p.baselinePred === p.goldMain;
    if (p.samples[0] === p.goldMain) accSingle++;
    if (p.majority === null) {
      noVote++;
      continue;
    }
    const nowRight = p.majority === p.goldMain;
    if (nowRight) accMajor++;
    if (!baseRight && nowRight) fixed++;
    else if (baseRight && !nowRight) broken++;
    else if (baseRight && nowRight) keptRight++;
    else stillWrong++;
    if (p.distinct > 1) {
      if (!baseRight && nowRight) divFixed++;
      else if (baseRight && !nowRight) divBroken++;
    } else if (p.majority !== p.baselinePred) {
      channelDiff++;
    }
  }
  const total = validProbes.length;
  const singleAcc = accSingle / total;
  const majorAcc = accMajor / total;
  const gainPt = (majorAcc - singleAcc) * 100;
  const divRate = divergent / total;
  console.log(
    `分歧率 ${(divRate * 100).toFixed(1)}%（${divergent}/${total}）  平票 ${ties}  无分歧但与基线不同 ${channelDiff}（通道差异，非采样功劳）`
  );
  console.log(
    `错例被多数票修正 ${fixed}  对例被改坏 ${broken}  对例保持 ${keptRight}  仍错 ${stillWrong}  无法裁决 ${noVote}`
  );
  console.log(
    `其中真正来自分歧的：修正 ${divFixed} / 破坏 ${divBroken}`
  );
  console.log(
    `准确率：首次单次 ${(singleAcc * 100).toFixed(1)}% → k=${K} 多数票 ${(majorAcc * 100).toFixed(1)}%  =  ${gainPt >= 0 ? "+" : ""}${gainPt.toFixed(1)}pt`
  );
  // 判据核心：多数票必须真的把准确率抬上去。修正>破坏只是必要条件，n 小时一条 case 就能翻盘。
  console.log(
    divRate < 0.05
      ? "→ 分歧率 <5%：多数投票没有可作用的对象，方案② 毙掉"
      : gainPt <= 0
        ? "→ 多数票与单次准确率持平或更差：方案② 不成立（此前的「修正>破坏」是通道差异冒充的）"
        : divFixed > divBroken && gainPt >= 2
          ? `→ 成立：分歧修正为主且净 +${gainPt.toFixed(1)}pt，值得铺全量（需再扩样本确认，勿凭单批外推）`
          : `→ 有分歧但净收益仅 ${gainPt.toFixed(1)}pt：不足以抵消 k 倍成本，暂不上全量`
  );

  // ---- 落盘（仅有效跑，避免垃圾报告污染 datasets/pilot）----
  const outDir = resolve(ROOT, "datasets/pilot");
  mkdirSync(outDir, { recursive: true });
  const outFile = resolve(outDir, `sampling-probe-k${K}-t${TEMP}-${DEFAULT_MODEL_CONFIG.version}.json`);
  writeFileSync(
    outFile,
    JSON.stringify(
      {
        k: K,
        temperature: TEMP,
        modelConfig: DEFAULT_MODEL_CONFIG,
        baselineRun: BASELINE_RUN,
        summary: {
          n,
          valid: validProbes.length,
          called,
          totalCost,
          divergentRate: divRate,
          ties,
          fixed,
          broken,
          keptRight,
          stillWrong,
          noVote,
        },
        probes,
      },
      null,
      1
    )
  );
  console.log(`报告 → ${outFile.replace(ROOT, ".")}`);
}
