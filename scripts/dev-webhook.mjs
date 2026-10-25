/**
 * webhook 服务启动器：注入 .env.local 后用 tsx 跑 apps/agent/src/webhook-server.ts
 *
 * 为什么需要它：webhook-server.ts 直接读 process.env，不自己加载 .env.local；
 * 在 Git Bash 里 `export $(cat .env.local)` 对含 \n 字面量/URL 特殊字符的值不安全。
 * 本脚本从仓库根读取 .env.local（已存在则不覆盖），再 spawn tsx，stdio 直通。
 *
 * 用法：node scripts/dev-webhook.mjs   （在仓库根执行；服务 cwd=仓库根，
 * 使 datasets/gateway/audit.jsonl 与 datasets/traces/traces.jsonl 落在正确位置）
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const ENV_PATH = path.join(ROOT, ".env.local");

if (fs.existsSync(ENV_PATH)) {
  for (const line of fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2];
    }
  }
}

const tsxCli = path.join(ROOT, "apps", "agent", "node_modules", "tsx", "dist", "cli.mjs");
const serverTs = path.join(ROOT, "apps", "agent", "src", "webhook-server.ts");

const child = spawn(process.execPath, [tsxCli, serverTs], {
  cwd: ROOT,
  stdio: "inherit",
  env: process.env,
});
child.on("exit", (code) => process.exit(code ?? 0));
