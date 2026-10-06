/**
 * 评测过夜包装器：等中转站恢复 → 断点续跑 dev/holdout 评测 → 直到两份报告落盘。
 * 探测与子进程全部容错（网络级异常不炸包装器）。
 *
 * 用法：pnpm tsx scripts/eval-overnight.mts   （run_in_background 运行）
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const RELAY = ((): string => {
  const env = existsSync(resolve(ROOT, ".env.local"))
    ? readFileSync(resolve(ROOT, ".env.local"), "utf8")
    : "";
  return (/^DEEPSEEK_BASE_URL=(.+)$/m.exec(env)?.[1] ?? "").trim().replace(/\/+$/, "");
})();

const DEV_REPORT = resolve(ROOT, "datasets/eval/run-baseline-mc11-dev-deepseek-v4.1-flash-mc-1.1-v1.json");
const HOLDOUT_REPORT = resolve(
  ROOT,
  "datasets/eval/run-final-holdout-holdout-deepseek-v4.1-flash-mc-1.1-v1.json"
);
const MAX_HOURS = 8;
const PROBE_INTERVAL_MS = 60_000;

async function probeRelay(): Promise<boolean> {
  try {
    const key = (/^DEEPSEEK_API_KEY=(.*)$/m.exec(
      readFileSync(resolve(ROOT, ".env.local"), "utf8")
    )?.[1] ?? "").trim();
    const res = await fetch(`${RELAY}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-v4.1-flash",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    // 200=可用；402/403=余额问题（同属"站点在线"）；401/404=配置错误需人工
    return res.status === 200 || res.status === 402 || res.status === 403;
  } catch {
    return false; // 连接超时/DNS 失败 = 站点不可达
  }
}

function runEval(args: string[]): number {
  const r = spawnSync("pnpm", ["eval:run", "--", ...args], {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  return r.status ?? 1;
}

(async () => {
  const deadline = Date.now() + MAX_HOURS * 3_600_000;
  console.log(`== eval-overnight == 中转站: ${RELAY} | 最长等待 ${MAX_HOURS}h`);

  while (Date.now() < deadline) {
    // 等站点可达
    let relayUp = false;
    while (Date.now() < deadline) {
      relayUp = await probeRelay();
      console.log(
        `[${new Date().toISOString().slice(11, 19)}] 探测: ${relayUp ? "在线" : "不可达"}`
      );
      if (relayUp) break;
      await new Promise((r) => setTimeout(r, PROBE_INTERVAL_MS));
    }
    if (!relayUp) {
      console.error("中转站长时间不可达，包装器退出。恢复后重新运行本脚本即可续跑。");
      process.exit(1);
    }

    // dev 基线（断点续跑：只补缺口）
    const dev = runEval(["--tag=baseline-mc11", "--split=dev", "--ds=v1"]);
    const devDone = existsSync(DEV_REPORT);
    console.log(`dev: exit=${dev} report=${devDone}`);

    // holdout 首评（dev 完成后再跑，避免额度竞争）
    let holdoutDone = false;
    if (devDone) {
      const holdout = runEval(["--tag=final-holdout", "--split=holdout", "--ds=v1"]);
      holdoutDone = existsSync(HOLDOUT_REPORT);
      console.log(`holdout: exit=${holdout} report=${holdoutDone}`);
    }

    if (devDone && holdoutDone) {
      console.log("✅✅ dev 基线 + holdout 首评全部完成");
      process.exit(0);
    }
    // 未完成（质量门拦截/部分失败）→ 等下一个窗口继续（断点保留）
    console.log("…… 未完成，等待下个窗口继续");
    await new Promise((r) => setTimeout(r, 5 * 60_000));
  }
  console.error("超过最长等待时间，包装器退出（断点保留，恢复后重跑本脚本）");
  process.exit(1);
})();
