/**
 * Bot 一键拉起（W4 运维）—— 服务 + 隧道 + webhook URL 自动回填
 *
 * 电脑重启 / 隧道断了之后跑这一个脚本即可：
 *   1. 清理 8787 端口与残留 cloudflared（尽力而为）
 *   2. 启动 webhook 服务（注入 .env.local，日志 -> logs/webhook.log）
 *   3. 启动 cloudflared 快速隧道（日志 -> logs/cloudflared.log）
 *   4. 从隧道日志解析新的 https://xxx.trycloudflare.com
 *   5. PATCH /app/hook/config 把新地址告诉 GitHub（含 secret）
 *   6. 隧道公网探活自检
 *
 * 用法：node scripts/bot-up.mjs
 * 凭据全部来自 .env.local，不打印任何密钥。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createSign, createPrivateKey } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const LOG_DIR = path.join(ROOT, "logs");
const PORT = 8787;

// ---- env ----
const envPath = path.join(ROOT, ".env.local");
if (!fs.existsSync(envPath)) {
  console.error("缺少 .env.local");
  process.exit(1);
}
for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}
const { GITHUB_APP_ID, GITHUB_WEBHOOK_SECRET } = process.env;
const PEM = process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n");
if (!GITHUB_APP_ID || !PEM || !GITHUB_WEBHOOK_SECRET) {
  console.error("缺少 GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY / GITHUB_WEBHOOK_SECRET");
  process.exit(1);
}

fs.mkdirSync(LOG_DIR, { recursive: true });
const log = (msg) => console.log(`[bot-up] ${msg}`);

// ---- 1. 清理残留（尽力而为，失败不阻断） ----
try {
  const out = execFileSync("C:\\Windows\\System32\\netstat.exe", ["-ano"], { encoding: "utf8" });
  const pids = [...new Set(
    out.split("\n")
      .filter((l) => l.includes(`:${PORT}`) && l.includes("LISTENING"))
      .map((l) => l.trim().split(/\s+/).pop())
      .filter((p) => p && p !== "0")
  )];
  for (const pid of pids) {
    try { execFileSync("C:\\Windows\\System32\\taskkill.exe", ["/F", "/PID", pid]); log(`已结束占用 ${PORT} 的进程 ${pid}`); } catch {}
  }
} catch {}
try {
  execFileSync("C:\\Windows\\System32\\taskkill.exe", ["/F", "/IM", "cloudflared.exe"]);
  log("已结束残留 cloudflared");
} catch {}

// ---- 2. webhook 服务（分离进程，日志落盘） ----
const serverLog = fs.openSync(path.join(LOG_DIR, "webhook.log"), "a");
const server = spawn(process.execPath, [path.join(ROOT, "scripts", "dev-webhook.mjs")], {
  cwd: ROOT,
  stdio: ["ignore", serverLog, serverLog],
  detached: true,
});
server.unref();
log(`webhook 服务已拉起（pid ${server.pid}，日志 logs/webhook.log）`);

// ---- 3. cloudflared 隧道 ----
const tunnelLogPath = path.join(LOG_DIR, "cloudflared.log");
const tunnelLog = fs.openSync(tunnelLogPath, "w");
const tunnel = spawn(path.join(ROOT, "cloudflared.exe"), [
  "tunnel", "--url", `http://localhost:${PORT}`, "--no-autoupdate",
], { cwd: ROOT, stdio: ["ignore", tunnelLog, tunnelLog], detached: true });
tunnel.unref();
log(`cloudflared 已拉起（pid ${tunnel.pid}，日志 logs/cloudflared.log）`);

// ---- 4. 解析隧道地址 ----
const TUNNEL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
let host = null;
for (let i = 0; i < 24; i++) {
  await new Promise((r) => setTimeout(r, 2500));
  const text = fs.readFileSync(tunnelLogPath, "utf8");
  const m = TUNNEL_RE.exec(text);
  if (m) { host = m[0].replace("https://", ""); break; }
}
if (!host) {
  console.error("60s 内没等到隧道地址，看 logs/cloudflared.log 排查");
  process.exit(1);
}
log(`隧道地址：https://${host}`);

// ---- 5. PATCH webhook 配置 ----
const now = Math.floor(Date.now() / 1000);
const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const input = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iat: now, exp: now + 540, iss: String(GITHUB_APP_ID) })}`;
const jwt = `${input}.${createSign("RSA-SHA256").update(input).sign(createPrivateKey(PEM), "base64url")}`;
const patch = await fetch("https://api.github.com/app/hook/config", {
  method: "PATCH",
  headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "evokeeper-bot-up" },
  body: JSON.stringify({ url: `https://${host}/webhook`, content_type: "json", secret: GITHUB_WEBHOOK_SECRET, insecure_ssl: "0" }),
});
if (!patch.ok) {
  console.error(`PATCH /app/hook/config 失败 ${patch.status}：${(await patch.text()).slice(0, 150)}`);
  process.exit(1);
}
log("GitHub webhook URL 已更新");

// ---- 6. 公网探活 ----
for (let i = 0; i < 8; i++) {
  const r = await fetch(`https://${host}/healthz`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (r?.ok) {
    console.log(`\n[bot-up] ✅ Bot 已上线：https://${host}/webhook → localhost:${PORT}`);
    console.log("[bot-up] 验证：去仓库提个 issue，或 node scripts/e2e-verify.mjs " + host);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 3000));
}
console.error("隧道地址已回填，但公网探活未通（可能要再等几秒——cloudflared 就绪有延迟）");
process.exit(1);
