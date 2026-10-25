/**
 * GitHub App 三元组一键装配（W4）
 *
 * 输入：只要一个 —— 下载下来的 .pem 私钥文件路径
 * 输出：.env.local 里的 GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY / GITHUB_INSTALLATION_ID
 *
 * 自动化逻辑：
 * 1. pem 文件名形如 "<app-slug>.2026-10-25.private-key.pem"，前缀即 app slug；
 * 2. GET /apps/{slug}（公开接口）反查数字 App ID；
 * 3. 用 pem 签 JWT，GET /app/installations 列出安装，单个则直接用；
 * 4. 换 installation token 验证整条认证链，并打印 App 可见的仓库；
 * 5. 写 .env.local（pem 压成单行 \n 转义），全程不打印任何密钥。
 *
 * 用法：node scripts/setup-app-env.mjs <path-to.pem> [--installation <id>]
 */
import fs from "node:fs";
import path from "node:path";
import { createSign, createPrivateKey } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const ENV_PATH = path.join(ROOT, ".env.local");

// ---- 参数 ----
const args = process.argv.slice(2);
const pemPath = args.find((a) => !a.startsWith("--"));
const valOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const forcedInstallId = valOf("--installation");
const forcedAppId = valOf("--app-id");

if (!pemPath) {
  console.error("用法：node scripts/setup-app-env.mjs <私钥.pem路径> [--installation <id>]");
  process.exit(1);
}
if (!fs.existsSync(pemPath)) {
  console.error(`找不到文件：${pemPath}`);
  process.exit(1);
}

const pemRaw = fs.readFileSync(pemPath, "utf8");
if (!pemRaw.includes("BEGIN RSA PRIVATE KEY") && !pemRaw.includes("BEGIN PRIVATE KEY")) {
  console.error("这个文件不像 PEM 私钥（没有 BEGIN 行），请确认下载的是 private key");
  process.exit(1);
}
const pem = pemRaw.trim();

// ---- 1. 文件名 → slug → App ID ----
const base = path.basename(pemPath).replace(/\.pem$/i, "");
const slugFromName = base.split(".")[0];

const gh = async (p, init = {}, token) => {
  const res = await fetch(`https://api.github.com${p}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "evokeeper-setup",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  return res;
};

async function resolveAppId() {
  // 试 slug 反查
  const res = await gh(`/apps/${encodeURIComponent(slugFromName)}`);
  if (res.ok) {
    const app = await res.json();
    return { appId: app.id, slug: app.slug, name: app.name };
  }
  return null;
}

let appInfo = null;
if (forcedAppId) {
  appInfo = { appId: Number(forcedAppId), slug: slugFromName, name: slugFromName };
} else {
  const res = await gh(`/apps/${encodeURIComponent(slugFromName)}`);
  if (res.ok) {
    const app = await res.json();
    appInfo = { appId: app.id, slug: app.slug, name: app.name };
  }
}
if (!appInfo) {
  console.error(`无法通过文件名 "${slugFromName}" 反查 App（GET /apps/${slugFromName} 失败）。`);
  console.error("请从 App 设置页 General → About 里抄 App ID，用 --app-id 传入重跑。");
  process.exit(1);
}
console.log(`✓ App：${appInfo.name}（App ID=${appInfo.appId}）`);

// ---- 2. 签 JWT ----
function signJwt(appId) {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const input = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iat: now, exp: now + 600, iss: String(appId) })}`;
  const key = createPrivateKey(pem);
  const sig = createSign("RSA-SHA256").update(input).sign(key, "base64url");
  return `${input}.${sig}`;
}

const jwt = signJwt(appInfo.appId);

// JWT 自检：GET /app 必须返回 200，否则说明 pem 与 App ID 不配对
const selfCheck = await gh("/app", {}, jwt);
if (!selfCheck.ok) {
  console.error(`✗ JWT 验证失败（GET /app -> ${selfCheck.status}）：pem 与 App ID 不匹配，或私钥已重新生成`);
  process.exit(1);
}
console.log("✓ JWT 签名验证通过（GET /app 200）");

// ---- 3. installation 列表 ----
let installationId = forcedInstallId;
if (!installationId) {
  const res = await gh("/app/installations?per_page=100", {}, jwt);
  if (!res.ok) {
    console.error(`✗ 查询 installation 失败：${res.status} ${(await res.text()).slice(0, 150)}`);
    process.exit(1);
  }
  const body = await res.json();
  const installations = Array.isArray(body) ? body : body.installations || [];
  if (installations.length === 0) {
    console.error("✗ 这个 App 还没有安装到任何账户/仓库。");
    console.error("  → 去 App 设置页 Install App 标签安装到沙盒仓库，然后重跑本脚本。");
    process.exit(1);
  }
  if (installations.length === 1) {
    installationId = installations[0].id;
    console.log(`✓ 唯一 installation：${installationId}（账户 ${installations[0].account.login}）`);
  } else {
    console.error("该 App 有多个 installation，请选一个后用 --installation 指定：");
    for (const i of installations) console.error(`  id=${i.id} account=${i.account.login}`);
    process.exit(1);
  }
}

// ---- 4. 换 token 并验证 + 看可见仓库 ----
const tokenRes = await gh(`/app/installations/${installationId}/access_tokens`, { method: "POST" }, jwt);
if (!tokenRes.ok) {
  console.error(`✗ installation token 获取失败：${tokenRes.status} ${(await tokenRes.text()).slice(0, 150)}`);
  process.exit(1);
}
const { token } = await tokenRes.json();
const repoRes = await gh("/installation/repositories?per_page=20", {}, token);
if (!repoRes.ok) {
  console.error(`✗ installation token 验证失败：${repoRes.status}`);
  process.exit(1);
}
const repos = await repoRes.json();
const repoNames = (repos.repositories || []).map((r) => r.full_name);
console.log(`✓ installation token 有效，App 可访问仓库：${repoNames.join(", ") || "（无——安装时没选仓库？）"}`);

// ---- 5. 写 .env.local ----
const pemOneLine = pem.replace(/\r\n/g, "\n").replace(/\n/g, "\\n");
const entries = {
  GITHUB_APP_ID: String(appInfo.appId),
  GITHUB_APP_PRIVATE_KEY: pemOneLine,
  GITHUB_INSTALLATION_ID: String(installationId),
};

let envContent = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : "";
for (const [key, value] of Object.entries(entries)) {
  const lines = envContent.split("\n").filter((l) => !new RegExp(`^${key}=`).test(l.trim()));
  envContent = lines.join("\n").replace(/\n*$/, "\n") + `${key}=${value}\n`;
}
fs.writeFileSync(ENV_PATH, envContent, "utf8");
console.log(`✓ 已写入 ${ENV_PATH}：GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY(单行) / GITHUB_INSTALLATION_ID`);
console.log("完成。下一步：启动 webhook 服务 + cloudflared 隧道，把 https://xxx.trycloudflare.com/webhook 填回 App 设置。");
