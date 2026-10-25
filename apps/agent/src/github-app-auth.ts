/**
 * GitHub App 认证（W4）—— App JWT → installation access token 两级交换
 *
 * 认证链：
 * 1. App 私钥（PEM）签发 RS256 JWT（10 分钟有效期，GitHub 限制 ≤600s）
 * 2. JWT 调 POST /app/installations/{id}/access_tokens 换 installation token（1h 有效）
 * 3. installation token 以 Bearer 调 REST API（权限由 App 安装时授予的 scope 决定）
 *
 * 令牌缓存：installation token 有效期 1h，缓存至过期前 5 分钟（GitHub 限速 20 次/h per installation）。
 * R2 对齐：App 只申请 Issues:write + Metadata:read（注册时勾选），代码层不检查 scope
 * 而是如实上报 403/404（越权动作在 GitHub 侧就会被拒）。
 *
 * 零依赖：RS256 签名用 node:crypto（createSign），JWT 格式见 GitHub 文档。
 */
import { createSign, createPrivateKey } from "node:crypto";

const GITHUB_API = "https://api.github.com";

export interface GithubAppAuthOptions {
  /** App 的数字 ID（GitHub App 设置页） */
  appId: string | number;
  /** App 私钥 PEM 全文（-----BEGIN RSA PRIVATE KEY----- ...） */
  privateKeyPem: string;
  /** 安装的数字 ID（安装 URL 末段或 /app/installations 列表） */
  installationId: string | number;
  apiBase?: string;
  /** 时钟注入（测试） */
  now?: () => Date;
  /** 令牌获取函数注入（测试：免网络） */
  fetchInstallationToken?: (jwt: string, installationId: string) => Promise<{ token: string; expiresAt: string }>;
}

interface CachedToken {
  token: string;
  /** epoch ms；提前 5 分钟视为过期 */
  expiresAtMs: number;
}

/** App 私钥签发 RS256 JWT（GitHub App 认证专用，10 分钟） */
export function signAppJwt(appId: string | number, privateKeyPem: string, now = new Date()): string {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const exp = issuedAt + 10 * 60; // GitHub 上限 600s
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: issuedAt, exp, iss: String(appId) };
  const enc = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");
  const signingInput = `${enc(header)}.${enc(payload)}`;
  const key = createPrivateKey(privateKeyPem);
  const signature = createSign("RSA-SHA256").update(signingInput).sign(key, "base64url");
  return `${signingInput}.${signature}`;
}

export class GithubAppAuth {
  private readonly appId: string;
  private readonly privateKeyPem: string;
  private readonly installationId: string;
  private readonly apiBase: string;
  private readonly now: () => Date;
  private readonly fetchToken: NonNullable<GithubAppAuthOptions["fetchInstallationToken"]>;
  private cached: CachedToken | null = null;

  constructor(opts: GithubAppAuthOptions) {
    this.appId = String(opts.appId);
    this.privateKeyPem = opts.privateKeyPem;
    this.installationId = String(opts.installationId);
    this.apiBase = opts.apiBase ?? GITHUB_API;
    this.now = opts.now ?? (() => new Date());
    this.fetchToken =
      opts.fetchInstallationToken ??
      (async (jwt: string, installationId: string) => {
        const res = await fetch(`${this.apiBase}/app/installations/${installationId}/access_tokens`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${jwt}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "evokeeper-agent",
          },
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
          throw new Error(
            `installation token 获取失败 ${res.status}: ${(await res.text()).slice(0, 150)}`
          );
        }
        const j = (await res.json()) as { token: string; expires_at: string };
        return { token: j.token, expiresAt: j.expires_at };
      });
  }

  /** 取有效 installation token（缓存命中直接返回） */
  async getToken(): Promise<string> {
    const nowMs = this.now().getTime();
    if (this.cached && this.cached.expiresAtMs - 5 * 60_000 > nowMs) {
      return this.cached.token;
    }
    const jwt = signAppJwt(this.appId, this.privateKeyPem, this.now());
    const { token, expiresAt } = await this.fetchToken(jwt, this.installationId);
    this.cached = { token, expiresAtMs: Date.parse(expiresAt) };
    return token;
  }

  /** 带认证的 REST 调用（令牌过期自动刷新一次） */
  async api(path: string, init?: RequestInit): Promise<Response> {
    const token = await this.getToken();
    const res = await fetch(`${this.apiBase}${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "evokeeper-agent",
        ...(init?.headers as Record<string, string> | undefined),
      },
    });
    return res;
  }
}

/** 从环境变量构造（.env.local / 部署环境） */
export function githubAppAuthFromEnv(): GithubAppAuth | null {
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  const installationId = process.env.GITHUB_INSTALLATION_ID;
  if (!appId || !privateKey || !installationId) return null;
  // PEM 在 .env / CI secret / Docker env 里通常压成单行（字面 \n），统一还原为真实换行；
  // 不还原的话 createPrivateKey 报 OpenSSL DECODER unsupported（W4 实测踩坑）。
  const pem = privateKey.includes("\\n") ? privateKey.replace(/\\n/g, "\n") : privateKey;
  return new GithubAppAuth({ appId, privateKeyPem: pem, installationId });
}
