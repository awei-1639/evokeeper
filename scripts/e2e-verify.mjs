/**
 * W4 端到端验证：webhook URL 回填 → 自动建测试 issue → 观察 Bot 行为
 *
 * 步骤：
 * 1. 探活隧道（healthz 经公网往返）
 * 2. PATCH /app 把 webhook URL 指向隧道（webhook_secret 同步带上）
 * 3. GET /app/hook/config 确认生效
 * 4. 用 installation token 在 awei-1639/evokeeper 建一个真实测试 issue
 * 5. 轮询 GET /app/hook/deliveries 看 GitHub 是否真的投递了
 * 6. 轮询该 issue 的标签/评论，看 Bot 是否动了
 *
 * 用法：node scripts/e2e-verify.mjs <tunnel-host>   例：node scripts/e2e-verify.mjs abc-xyz-123.trycloudflare.com
 * 凭据全部来自 .env.local，不打印任何密钥。
 */
import fs from "node:fs";
import path from "node:path";
import { createSign, createPrivateKey } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ---- env ----
const envPath = path.join(ROOT, ".env.local");
for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}
const APP_ID = process.env.GITHUB_APP_ID;
const PEM = process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n");
const INSTALL_ID = process.env.GITHUB_INSTALLATION_ID;
const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;
const REPO = process.env.E2E_REPO || "awei-1639/evokeeper";

const TUNNEL_HOST = process.argv[2];
if (!TUNNEL_HOST || !APP_ID || !PEM || !INSTALL_ID) {
  console.error("用法：node scripts/e2e-verify.mjs <tunnel-host>（且 .env.local 三元组齐全）");
  process.exit(1);
}

const signJwt = () => {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const input = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iat: now, exp: now + 540, iss: String(APP_ID) })}`;
  return `${input}.${createSign("RSA-SHA256").update(input).sign(createPrivateKey(PEM), "base64url")}`;
};
const gh = async (p, init = {}, token) => {
  const res = await fetch(`https://api.github.com${p}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "evokeeper-e2e",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {}),
    },
  });
  return res;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function installationToken() {
  const r = await gh(`/app/installations/${INSTALL_ID}/access_tokens`, { method: "POST" }, signJwt());
  if (!r.ok) throw new Error(`installation token 失败 ${r.status}`);
  return (await r.json()).token;
}

// ---- 1. 隧道探活 ----
console.log(`[1] 探活隧道 https://${TUNNEL_HOST}/healthz ...`);
const health = await fetch(`https://${TUNNEL_HOST}/healthz`, {
  headers: { "User-Agent": "evokeeper-e2e" },
  signal: AbortSignal.timeout(15_000),
}).catch((e) => ({ ok: false, status: String(e.message) }));
console.log(`    -> ${health.ok ? "✓ 通" : "✗ " + health.status}`);

// ---- 2. PATCH /app/hook/config 回填 webhook URL ----
console.log(`[2] PATCH /app/hook/config webhook_url = https://${TUNNEL_HOST}/webhook ...`);
const patch = await gh(
  "/app/hook/config",
  {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: `https://${TUNNEL_HOST}/webhook`,
      content_type: "json",
      secret: WEBHOOK_SECRET,
      insecure_ssl: "0",
    }),
  },
  signJwt()
);
console.log(`    -> ${patch.ok ? "✓ 200" : "✗ " + patch.status + " " + (await patch.text()).slice(0, 200)}`);
if (!patch.ok) process.exit(1);

// ---- 3. 确认 ----
const cfg = await gh("/app/hook/config", {}, signJwt());
if (cfg.ok) {
  const j = await cfg.json();
  console.log(`[3] hook config: url=${j.url} active=${j.active}（secret 已设不回显）`);
} else {
  console.log(`[3] GET /app/hook/config -> ${cfg.status}`);
}

// ---- 4. 建测试 issue ----
const token = await installationToken();
console.log(`[4] 在 ${REPO} 建测试 issue ...`);
const now = new Date().toISOString().slice(0, 19).replace("T", " ");
const createRes = await gh(
  `/repos/${REPO}/issues`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: `[W4验证] 分诊接口偶发 500：LLM 返回非法 JSON 未重试成功`,
      body: [
        `> EvoKeeper W4 链路验证 issue（${now} 自动创建，验证后可关闭）。`,
        ``,
        `**环境**：pnpm monorepo，Node 22，DeepSeek 官方 API`,
        ``,
        `**预期行为**：triage 结构化输出校验失败时应自动重试，3 次均失败后 escalate 并记录 trace，不应把 500 直接抛给调用方。`,
        ``,
        `**实际行为**：批量评测跑到第 37 条时，gateway 收到 HTTP 500，日志里只有 "invalid signature" 之外的空错误信息，issue 侧没有任何反馈。`,
        ``,
        `**复现**：连续跑 \`node scripts/eval-triage.mjs --slice dev\` 两次，第二次大概率命中。`,
      ].join("\n"),
    }),
  },
  token
);
if (!createRes.ok) {
  console.error(`    -> ✗ 建失败 ${createRes.status}: ${(await createRes.text()).slice(0, 200)}`);
  process.exit(1);
}
const issue = await createRes.json();
console.log(`    -> ✓ #${issue.number} ${issue.html_url}`);
fs.writeFileSync(path.join(ROOT, ".e2e-issue-number"), String(issue.number), "utf8");

// ---- 5. 轮询投递记录 ----
console.log(`[5] 等 GitHub 投递 webhook（每 5s 查一次 /app/hook/deliveries，最多 60s）...`);
const pollStartAt = Date.now();
let delivered = null;
for (let i = 0; i < 12; i++) {
  await sleep(5000);
  const d = await gh("/app/hook/deliveries?per_page=10", {}, signJwt());
  if (d.ok) {
    const list = await d.json();
    // deliveries 列表的 url 字段恒为空，改按 event/action/时间窗匹配
    const hit = (Array.isArray(list) ? list : list.deliveries || []).find(
      (x) => x.event === "issues" && x.action === "opened" && Date.parse(x.delivered_at) > pollStartAt - 60_000
    );
    if (hit) {
      delivered = hit;
      console.log(`    -> ✓ 投递 ${hit.guid.slice(0, 8)} event=${hit.event} status=${hit.status_code}`);
      break;
    }
  }
  process.stdout.write(`    ... ${5 * (i + 1)}s 尚无投递\r`);
}
if (!delivered) console.log(`    -> ✗ 60s 内没有 webhook 投递记录（检查 App 事件订阅是否勾了 Issues）`);

// ---- 6. 轮询 issue 上的 Bot 行为 ----
console.log(`[6] 观察 issue #${issue.number} 上的标签/评论（每 5s，最多 90s）...`);
let acted = false;
for (let i = 0; i < 18; i++) {
  await sleep(5000);
  const r = await gh(`/repos/${REPO}/issues/${issue.number}`, {}, token);
  if (r.ok) {
    const j = await r.json();
    const labels = (j.labels || []).map((l) => (typeof l === "string" ? l : l.name));
    const c = await gh(`/repos/${REPO}/issues/${issue.number}/comments?per_page=10`, {}, token);
    const comments = c.ok ? await c.json() : [];
    if (labels.length > 0 || comments.length > 0) {
      console.log(`    -> ✓ 标签: [${labels.join(", ")}]  评论数: ${comments.length}`);
      for (const cm of comments.slice(0, 3)) {
        console.log(`       ${cm.user.login}: ${String(cm.body).replace(/\s+/g, " ").slice(0, 100)}`);
      }
      acted = true;
      break;
    }
  }
  process.stdout.write(`    ... ${5 * (i + 1)}s Bot 还没动作\r`);
}
if (!acted) console.log(`    -> ✗ 90s 内 Bot 未动作（看 webhook 服务日志与 /app/hook/deliveries 响应码）`);

console.log(acted ? "\n端到端链路 ✓ 打通" : "\n端到端未完成，按上面线索排查");
