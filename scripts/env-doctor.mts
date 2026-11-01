/**
 * env-doctor：LLM 环境体检（零成本，不调用计费接口）。
 *
 * 为什么需要它（2026-11-01）：
 *   `curl code=000` 这个症状在三天里出现过三次，每次原因都不同——
 *   ① HTTPS_PROXY 指向已停的端口（61926 → 50154 两代死端口）；
 *   ② Clash TUN 的 Fake-IP（DNS 全解析到 198.18.x.x）让"直连"必然失败；
 *   ③ 站点真的挂了（503 no available channel）。
 *   三者都表现为"连不上"，但处置完全不同。以前靠人工逐个 curl 猜，浪费了整轮排查。
 *
 * 判据（按顺序，前一条否掉就不必跑后面）：
 *   1. 代理端口是否真有监听（TCP connect，不看 HTTP）；
 *   2. DNS 是否落在 Fake-IP 段（198.18.0.0/15）→ 决定能不能省略代理；
 *   3. 目标站点 /v1/models 是否可达（带 key，200 才算通）；
 *   4. 配置的 triage 模型是否在清单里（不在就别指望 chat 能通）。
 *
 * 用法：pnpm exec tsx scripts/env-doctor.mts [--proxy=http://127.0.0.1:7897]
 * 退出码：0 全部通过；1 有阻塞项。
 */
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const arg = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];

// ---- 读 .env.local（不打印任何密钥值）----
function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  let txt = "";
  try {
    txt = readFileSync(resolve(ROOT, ".env.local"), "utf8");
  } catch {
    return out;
  }
  for (const line of txt.split("\n")) {
    const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    out[m[1]!] = (m[2] ?? "").replace(/\s+#.*$/, "").trim();
  }
  return out;
}

const env = loadEnv();

// ---- 1. 代理端口探测 ----
function tcpProbe(host: string, port: number, timeoutMs = 2500): Promise<boolean> {
  return new Promise((res) => {
    const sock = connect({ host, port });
    const done = (ok: boolean) => {
      sock.destroy();
      res(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

function parseProxy(url: string): { host: string; port: number } | null {
  try {
    const u = new URL(url.includes("://") ? url : `http://${url}`);
    return { host: u.hostname, port: Number(u.port || 80) };
  } catch {
    return null;
  }
}

const envProxy = env.HTTPS_PROXY ?? process.env.HTTPS_PROXY ?? "";
const candidates = [
  ...(arg("proxy") ? [arg("proxy")!] : []),
  ...(envProxy ? [envProxy] : []),
  "http://127.0.0.1:7897",
].filter((v, i, a) => a.indexOf(v) === i);

/**
 * 代理是否「真的能用」必须发一个请求验证，不能只测 TCP 握手。
 * 2026-11-01 实例：127.0.0.1:50154 接受 TCP 连接，但 curl 走它一律 exit 7（连接被拒），
 * 只测端口会给出「✓ 可用」的假阳性——和本项目此前「测试通过但实际没测」是同一类错误。
 */
async function proxyWorks(url: string): Promise<{ ok: boolean; status: number }> {
  const p = parseProxy(url);
  if (!p || !(await tcpProbe(p.host, p.port))) return { ok: false, status: 0 };
  try {
    const undici = await import("undici");
    const res = await undici.fetch("https://api.siliconflow.cn/v1/models", {
      dispatcher: new undici.ProxyAgent(url),
      signal: AbortSignal.timeout(10_000),
    });
    // 401/403 也算通：说明请求到达了站点，只是没带 key
    return { ok: res.status > 0, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

const proxyRows: { url: string; alive: boolean; status: number }[] = [];
for (const c of candidates) {
  const r = await proxyWorks(c);
  proxyRows.push({ url: c, alive: r.ok, status: r.status });
}
const liveProxy = proxyRows.find((r) => r.alive)?.url ?? null;

// ---- 2. Fake-IP 判定 ----
async function resolveIp(host: string): Promise<string | null> {
  try {
    const { lookup } = await import("node:dns/promises");
    const r = await lookup(host);
    return r.address;
  } catch {
    return null;
  }
}

const targets = [
  { name: "deepseek 通道", host: (env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1").replace(/^https?:\/\//, "").split("/")[0]!, base: env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1", key: env.DEEPSEEK_API_KEY ?? "" },
  { name: "siliconflow", host: "api.siliconflow.cn", base: env.SILICONFLOW_BASE_URL ?? "https://api.siliconflow.cn/v1", key: env.SILICONFLOW_API_KEY ?? "" },
];

const dnsRows: { host: string; ip: string | null; fakeIp: boolean }[] = [];
for (const t of targets) {
  const ip = await resolveIp(t.host);
  const fakeIp = !!ip && /^198\.1[89]\./.test(ip);
  dnsRows.push({ host: t.host, ip, fakeIp });
}

// ---- 3+4. 站点可达性与模型清单 ----
type SiteResult = { name: string; name2: string; code: number; modelCount: number | null; hasModel: boolean | null; note: string };

async function probeSite(t: (typeof targets)[number], model: string): Promise<SiteResult> {
  const base = t.base.replace(/\/+$/, "");
  const url = `${base}/models`;
  let code = 0;
  let body = "";
  try {
    // Node 内置 fetch 不认 `proxy` 选项，必须用 undici 的 dispatcher；
    // 这一条正是本脚本第一天就该踩到的坑：Fake-IP 下直连必失败，用内置 fetch 体检会误报"站点挂了"。
    const undici = await import("undici");
    const res = await undici.fetch(url, {
      headers: { Authorization: `Bearer ${t.key}` },
      signal: AbortSignal.timeout(20_000),
      dispatcher: liveProxy ? new undici.ProxyAgent(liveProxy) : undefined,
    });
    code = res.status;
    body = await res.text();
  } catch (e) {
    return {
      name: t.name,
      name2: t.host,
      code: 0,
      modelCount: null,
      hasModel: null,
      note: `连接失败：${(e as Error).message.slice(0, 60)}`,
    };
  }
  let count: number | null = null;
  let has: boolean | null = null;
  try {
    const j = JSON.parse(body) as { data?: { id: string }[] };
    if (Array.isArray(j.data)) {
      count = j.data.length;
      has = j.data.some((m) => m.id === model);
    }
  } catch {
    /* 非 JSON（多为网关错误页） */
  }
  const note =
    code === 200
      ? count === 0
        ? "站点在线但模型清单为空（渠道全下线）"
        : has === false
          ? `清单内无 ${model}`
          : "正常"
      : `HTTP ${code}：${body.slice(0, 80).replace(/\s+/g, " ")}`;
  return { name: t.name, name2: t.host, code, modelCount: count, hasModel: has, note };
}

const triageModel = "amd/deepseek-v4-flash";
const sites: SiteResult[] = [];
for (const t of targets) sites.push(await probeSite(t, triageModel));

// ---- 输出 ----
console.log("== LLM 环境体检 ==");
console.log(`\n[代理端口]  环境变量 HTTPS_PROXY = ${envProxy || "(未设置)"}`);
for (const r of proxyRows)
  console.log(`  ${r.alive ? "✓" : "✗"} ${r.url}  (经它请求站点 → HTTP ${r.status || "无响应"})`);
if (!liveProxy) console.log("  → 无可用代理。若非 Fake-IP 网络可直连；Fake-IP 下必然全站 000。");
else if (envProxy && liveProxy !== envProxy)
  console.log(`  → 注意：环境变量指向的代理不可用，实际可用的是 ${liveProxy}（脚本需显式传 HTTPS_PROXY=${liveProxy}）`);

console.log("\n[DNS]");
for (const r of dnsRows)
  console.log(`  ${r.host.padEnd(22)} ${r.ip ?? "(解析失败)"}${r.fakeIp ? "  ← Fake-IP 段，直连不可行" : ""}`);

console.log("\n[站点]");
for (const s of sites) {
  const cnt = s.modelCount === null ? "-" : String(s.modelCount);
  const has = s.hasModel === null ? "-" : s.hasModel ? "有" : "无";
  console.log(`  ${s.name.padEnd(14)} code=${String(s.code).padEnd(4)} 模型数=${cnt.padEnd(4)} 含triage模型=${has}  ${s.note}`);
}

const blocking: string[] = [];
if (!liveProxy && dnsRows.some((d) => d.fakeIp)) blocking.push("Fake-IP 生效但无可用代理端口");
const usable = sites.find((s) => s.code === 200 && s.hasModel === true);
if (!usable) blocking.push(`没有任何站点同时满足「可达 + 含 ${triageModel}」`);

console.log("\n[结论]");
if (blocking.length === 0) {
  console.log(`  ✓ 可用：${usable!.name}（${usable!.name2}）`);
  process.exit(0);
}
for (const b of blocking) console.log(`  ✗ ${b}`);
console.log(`\n  处置：若配了 HTTPS_PROXY 却不可用，先改正或置空；Fake-IP 网络下跑脚本需 HTTPS_PROXY=${liveProxy ?? "http://127.0.0.1:<端口>"}`);
process.exit(1);
