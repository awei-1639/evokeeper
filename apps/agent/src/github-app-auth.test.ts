/**
 * GitHub App 认证测试：JWT 签名格式 + 令牌交换 + 缓存 + 环境构造
 *
 * 用一次性 RSA 密钥对（node:crypto 生成，测试后即弃）验证：
 * - JWT header/payload/signature 结构（RS256 可验证）
 * - installation token 交换（fetch 注入，免网络）
 * - 令牌缓存（1h 有效，提前 5 分钟刷新；GitHub 限速 20 次/h）
 */
import { createHash, createPublicKey, generateKeyPairSync, createVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GithubAppAuth, githubAppAuthFromEnv, signAppJwt } from "./github-app-auth";

function onceKeyPair() {
  return generateKeyPairSync("rsa", { modulusLength: 2048 });
}

function b64urlToJson(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

describe("signAppJwt", () => {
  it("RS256 JWT：header/payload 正确且签名可验证", () => {
    const { publicKey, privateKey } = onceKeyPair();
    const now = new Date("2026-10-25T10:00:00Z");
    const pem = String(privateKey.export({ type: "pkcs1", format: "pem" }));
    const jwt = signAppJwt(12345, pem, now);
    const parts = jwt.split(".");
    const h = parts[0] ?? "";
    const p = parts[1] ?? "";
    const s = parts[2] ?? "";
    expect(b64urlToJson(h)).toEqual({ alg: "RS256", typ: "JWT" });
    const payload = b64urlToJson(p);
    expect(payload["iat"]).toBe(Math.floor(now.getTime() / 1000));
    expect(payload["exp"]).toBe(Math.floor(now.getTime() / 1000) + 600); // 10 分钟
    expect(payload["iss"]).toBe("12345");
    const ok = createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, s, "base64url");
    expect(ok).toBe(true);
  });
});

describe("GithubAppAuth", () => {
  function fixture() {
    const { privateKey } = onceKeyPair();
    const calls: string[] = [];
    const auth = new GithubAppAuth({
      appId: "999",
      privateKeyPem: String(privateKey.export({ type: "pkcs1", format: "pem" })),
      installationId: "777",
      fetchInstallationToken: async (jwt, installationId) => {
        calls.push(`${installationId}:${jwt.slice(0, 10)}`);
        return { token: `inst_tok_${calls.length}`, expiresAt: "2026-10-25T11:00:00Z" };
      },
    });
    return { auth, calls };
  }

  it("令牌交换 + 缓存：两次 getToken 只触发一次交换", async () => {
    const { auth, calls } = fixture();
    const t1 = await auth.getToken();
    const t2 = await auth.getToken();
    expect(t1).toBe("inst_tok_1");
    expect(t2).toBe("inst_tok_1");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^777:/);
  });

  it("api() 带令牌调用（fetch 注入验证头）", async () => {
    const { publicKey, privateKey } = onceKeyPair();
    let captured: Record<string, string> = {};
    const auth = new GithubAppAuth({
      appId: "999",
      privateKeyPem: String(privateKey.export({ type: "pkcs1", format: "pem" })),
      installationId: "777",
      fetchInstallationToken: async () => ({ token: "tok_abc", expiresAt: "2099-01-01T00:00:00Z" }),
      apiBase: "http://test.invalid",
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      captured = { url: String(url), auth: String((init?.headers as Record<string, string>)?.Authorization) };
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      await auth.api("/repos/alibaba/nacos/issues/1");
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(captured.url).toBe("http://test.invalid/repos/alibaba/nacos/issues/1");
    expect(captured.auth).toBe("Bearer tok_abc");
    void publicKey;
  });
});

describe("githubAppAuthFromEnv", () => {
  it("三元组齐才构造，缺一返回 null", () => {
    const saved = { ...process.env };
    try {
      delete process.env.GITHUB_APP_ID;
      delete process.env.GITHUB_APP_PRIVATE_KEY;
      delete process.env.GITHUB_INSTALLATION_ID;
      expect(githubAppAuthFromEnv()).toBeNull();
      process.env.GITHUB_APP_ID = "1";
      expect(githubAppAuthFromEnv()).toBeNull();
      process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN-----";
      process.env.GITHUB_INSTALLATION_ID = "2";
      expect(githubAppAuthFromEnv()).not.toBeNull();
    } finally {
      Object.assign(process.env, saved);
    }
  });
});
