/**
 * 查询当前用户可访问的 GitHub App installation 列表
 * 用途：App 注册完成后，自动发现 App ID / Installation ID（免去手动抄）
 * token：从 .env.local 读 GITHUB_TOKEN（不入库、不打印）
 * 用法：node scripts/check-app-install.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function loadToken() {
  const envPath = path.join(ROOT, ".env.local");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const m = /^GITHUB_TOKEN=(.+)$/.exec(line.trim());
      if (m) return m[1].trim();
    }
  }
  return process.env.GITHUB_TOKEN || "";
}

const TOKEN = loadToken();
if (!TOKEN) {
  console.error("缺少 GITHUB_TOKEN");
  process.exit(1);
}

const res = await fetch("https://api.github.com/user/installations?per_page=100", {
  headers: {
    Authorization: `Bearer ${TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "evokeeper-setup",
  },
});

if (!res.ok) {
  console.error(`GitHub API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  process.exit(1);
}

const data = await res.json();

if (data.total_count === 0) {
  console.log("当前 token 下没有任何 App installation（App 还没安装到仓库）");
  process.exit(0);
}

for (const inst of data.installations) {
  console.log(
    [
      `app: ${inst.app_slug} (app_id=${inst.app_id})`,
      `installation_id=${inst.id}`,
      `account: ${inst.account.login}`,
      `scope: ${inst.repository_selection}`,
      `installed_at: ${inst.created_at}`,
    ].join(" | ")
  );
}
