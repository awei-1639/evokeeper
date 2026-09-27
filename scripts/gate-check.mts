/**
 * 门禁判定脚本（W6）—— 消费两个 EvalRun JSON，执行 §7.2 五条判定
 *
 * 用法：
 *   pnpm eval:gate -- --baseline=datasets/eval/run-baseline-....json \
 *                    --candidate=datasets/eval/run-cand-1-dev-....json \
 *                    [--baseline-holdout=...] [--candidate-holdout=...] \
 *                    [--adversarial=0.97] [--model-config-changed]
 * 退出码：passed=0 / failed=1（CI 可直接挂）
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateGate, type EvalRun } from "../packages/eval/src/index";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (name: string): string | undefined =>
  process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

function loadRun(name: string, path: string | undefined): EvalRun | undefined {
  if (!path) return undefined;
  const raw = JSON.parse(readFileSync(resolve(HERE, "..", path), "utf8")) as { run: EvalRun };
  if (!raw.run) throw new Error(`${name} 文件格式错误（缺 run 字段）：${path}`);
  return raw.run;
}

const baseline = loadRun("baseline", arg("baseline"));
const candidate = loadRun("candidate", arg("candidate"));
if (!baseline || !candidate) {
  console.error("必须提供 --baseline=<path> 与 --candidate=<path>（eval:run 的产出）");
  process.exit(1);
}

const decision = evaluateGate({
  baseline,
  candidate,
  baselineHoldout: loadRun("baseline-holdout", arg("baseline-holdout")),
  candidateHoldout: loadRun("candidate-holdout", arg("candidate-holdout")),
  adversarialPassRate: arg("adversarial") ? Number(arg("adversarial")) : undefined,
  modelConfigChanged: process.argv.includes("--model-config-changed"),
});

console.log("== eval:gate 门禁判定 ==");
console.log(`baseline: ${baseline.id} | candidate: ${candidate.id} | dataset: ${candidate.datasetVersion}`);
for (const c of decision.checks) {
  console.log(`  ${c.passed ? "✓" : c.detail.startsWith("skipped") ? "⊘" : "✗"} ${c.rule}`);
  console.log(`     ${c.detail}`);
}
console.log(`\n结论: ${decision.passed ? "PASSED —— 可进入发布流程（灰度）" : "REJECTED —— 候选不得发布"}`);
process.exit(decision.passed ? 0 : 1);
