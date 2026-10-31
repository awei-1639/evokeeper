/**
 * needs-more-info 可学性探针（结论：不可学，别再追这个点）
 *
 * 现象：v2 dev 上 nmi 命中 **0/33**、误报 2。看起来像"模型不会请求补充信息"，很诱人。
 *
 * 实测结论：gold 的 needs-more-info 不是「文本信息不足」，而是**事件标注**——
 * 它记录的是"维护者当时确实追问过/要求补充过"。检验方法：若 nmi 组的文本信息完整度
 * （版本号/日志/代码块/复现描述）不低于对照组，则文本侧不存在可学信号。
 *
 * 本探针只读数据、零 LLM 调用，用于把这个「此路不通」固定下来：
 * 后续任何人想提「加个规则判 nmi」，先跑这个脚本看数字。
 *
 * 用法：pnpm exec tsx scripts/nmi-probe.mts
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// 用最新一次 v2 dev 评测确定样本范围（与混淆矩阵同一批 case）
const RUN = process.argv.find((a) => a.startsWith("--run="))?.split("=").slice(1).join("=")
  ?? "run-v2-tp14d2-dev-deepseek-v4-flash-mc-1.0-v2.json";

interface Detail {
  caseId: string;
  goldMain: string;
  predMain: string | null;
  predNeedsMoreInfo: boolean;
}
const runJson = JSON.parse(readFileSync(resolve(ROOT, "datasets/eval", RUN), "utf8")) as {
  perCaseDetail: Detail[];
  nmi: { hit: number; goldCount: number; falsePositives: number };
};
const ids = new Set(runJson.perCaseDetail.map((c) => c.caseId));
const byId = new Map(runJson.perCaseDetail.map((c) => [c.caseId, c]));

interface GoldRecord {
  id: string;
  title: string;
  body: string;
  labels: string[];
}
const records: GoldRecord[] = [];
for (const line of readFileSync(resolve(ROOT, "datasets/drafts/alibaba_nacos.jsonl"), "utf8").split("\n")) {
  if (!line.trim()) continue;
  const r = JSON.parse(line) as Record<string, unknown>;
  const id = String(r["id"]);
  if (!ids.has(id)) continue;
  const labels = Array.isArray(r["labels_gold"]) ? (r["labels_gold"] as string[]) : [];
  if (labels.length === 0) continue;
  records.push({
    id,
    title: String(r["title"] ?? ""),
    body: String(r["body_excerpt"] ?? ""),
    labels,
  });
}

/** 文本「信息完整度」要素（任一项存在即认为提供了该线索） */
const FEATURES: Array<{ name: string; test: (t: string) => boolean }> = [
  { name: "版本号(3.1.1)", test: (t) => /\d+\.\d+\.\d+/.test(t) },
  { name: "异常栈(Exception/ERROR)", test: (t) => /Exception|ERROR|Error:|WARN|Caused by/.test(t) },
  { name: "代码块/配置", test: (t) => /```|<\/?[a-z-]+>|\w+\.(java|yml|yaml|properties|xml)/i.test(t) },
  { name: "复现/现象描述", test: (t) => /复现|现象|步骤|预期|实际|step|reproduce|expected|actual|描述/i.test(t) },
  { name: "截图", test: (t) => /!\[|<img|user-attachments/.test(t) },
  { name: "环境信息", test: (t) => /环境|版本|version|OS|JDK|Spring|Docker|K8s|k8s/i.test(t) },
];

const nmi = records.filter((r) => r.labels.includes("needs-more-info"));
const other = records.filter((r) => !r.labels.includes("needs-more-info"));

function ratio(group: GoldRecord[], f: (t: string) => boolean): number {
  if (group.length === 0) return 0;
  return group.filter((r) => f(`${r.title}\n${r.body}`)).length / group.length;
}

console.log(`样本 ${records.length} 条（基线 ${RUN}）`);
console.log(`实际 nmi 报告：命中 ${runJson.nmi.hit}/${runJson.nmi.goldCount}，误报 ${runJson.nmi.falsePositives}`);
console.log(`分组：nmi ${nmi.length} 条 / 非 nmi ${other.length} 条\n`);

console.log(`要素                       nmi占比   非nmi占比   差值`);
for (const f of FEATURES) {
  const a = ratio(nmi, f.test);
  const b = ratio(other, f.test);
  const diff = a - b;
  console.log(
    `${f.name.padEnd(24)} ${(a * 100).toFixed(1).padStart(6)}%   ${(b * 100).toFixed(1).padStart(7)}%   ${(diff >= 0 ? "+" : "")}${(diff * 100).toFixed(1)}pt`
  );
}

// 如果 nmi 组的信息完整度不低于对照组，说明 gold nmi 不是文本属性
const avgNmi = FEATURES.reduce((s, f) => s + ratio(nmi, f.test), 0) / FEATURES.length;
const avgOther = FEATURES.reduce((s, f) => s + ratio(other, f.test), 0) / FEATURES.length;
console.log(
  `\n信息完整度均值：nmi ${(avgNmi * 100).toFixed(1)}% vs 非 nmi ${(avgOther * 100).toFixed(1)}%（差 ${((avgNmi - avgOther) * 100).toFixed(1)}pt）`
);

const predNmiPositive = runJson.perCaseDetail.filter((c) => c.predNeedsMoreInfo).length;
console.log(`模型判定 needs-more-info 的次数：${predNmiPositive} / ${runJson.perCaseDetail.length}`);
console.log(
  avgNmi >= avgOther - 0.05
    ? "\n→ 结论：nmi 组文本信息量与对照组相当或更高 ⇒ gold 的 needs-more-info 记录的是「维护者当时追问过」这一事件，不是可从 issue 文本判定的属性。**0/33 不是模型缺陷，是指标不可学**。"
    : "\n→ 结论：nmi 组文本信息量明显偏低 ⇒ 存在文本可学信号，值得做规则/prompt 实验。"
);
