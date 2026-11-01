/**
 * LLM 传输层：三家供应商（DeepSeek / 百炼 / 智谱）均提供 OpenAI 兼容端点，
 * 因此统一用一个 OpenAI 兼容客户端覆盖 —— design.md §9.1 的选型可直接切换。
 *
 * 传输层与业务逻辑解耦：测试用 createMockTransport 注入，无需联网与 API Key。
 */
import { PROVIDER_ENV_KEY, getBaseUrl, getSpec, type Provider } from "./config";
import { isFatalLlmError } from "./errors";

export interface ChatRequest {
  model: string;
  system: string;
  user: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** 是否要求 JSON 输出（模型支持时才下发 response_format） */
  jsonMode?: boolean;
}

export interface ChatResponse {
  content: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export interface EmbedRequest {
  model: string;
  input: string[];
}

export interface EmbedResponse {
  vectors: number[][];
  inputTokens: number;
}

export interface LlmTransport {
  chat(req: ChatRequest): Promise<ChatResponse>;
  embed(req: EmbedRequest): Promise<EmbedResponse>;
}

export interface HttpTransportOptions {
  apiKeys?: Partial<Record<Provider, string>>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
}

interface ChatCompletionBody {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /** DeepSeek */
    prompt_cache_hit_tokens?: number;
    /** OpenAI 风格 */
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

interface EmbeddingBody {
  data?: Array<{ embedding?: number[] }>;
  usage?: { prompt_tokens?: number };
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 退避：300ms → 1200ms */
function backoff(attempt: number): number {
  return 300 * (attempt + 1) ** 2;
}

/**
 * 从 429 响应体解析频控冷却时长（秒）。
 * 匹配中转站文案「请等待 526 秒后再试」；官方 API 无此文案时返回 null（走普通退避）。
 * 上限 900s：防止被异常文案骗到无限挂起。
 */
export function parseRateLimitCooldown(body: string): number | null {
  // 中文中转站：请等待 526 秒
  const zh = /请等待\s*(\d+)\s*秒/.exec(body);
  if (zh?.[1]) return Math.min(Number(zh[1]), 900);
  // new-api 英文：maximum 10 requests in 1 minutes（2026-11-01 xxs 实测文案）
  const en = /maximum\s+\d+\s+requests?\s+(?:in|per)\s+(\d+)\s*(second|seconds|minute|minutes|hour|hours)/i.exec(body);
  if (en?.[1]) {
    const n = Number(en[1]);
    const unit = (en[2] ?? "seconds").toLowerCase();
    const sec = unit.startsWith("hour") ? n * 3600 : unit.startsWith("minute") ? n * 60 : n;
    return Math.min(sec, 900);
  }
  // 标准头语义：retry after: 30
  const ra = /retry[- ]after[:\s]+(\d+)/i.exec(body);
  if (ra?.[1]) return Math.min(Number(ra[1]), 900);
  return null;
}

/**
 * 通道级最小请求间隔（毫秒）。默认 0 = 不限速。
 *
 * 为什么需要：限流是**服务器侧**的硬约束，客户端只能节流适配。2026-11-01 实测
 * xxs 中转站限「10 requests / 1 minute」，用 1.2s 间隔跑 40 条保真度时 29 条被 429 打回，
 * 一致率被算成 88%——限流差点被误读成「通道不等价」。重试救不了这种约束（窗口内必然再失败），
 * 唯一正确做法是提前把间隔拉开：
 *   EVOKEEPER_LLM_MIN_INTERVAL_MS=6500 pnpm exec tsx scripts/run-eval.mts ...
 */
const providerNextAt = new Map<string, number>();

/** 每次调用时读环境变量：ESM 的 import 先于脚本加载 .env.local，
 *  若在模块初始化时读，写在 .env.local 里的间隔会永远读不到（静默失效）。 */
function minIntervalMs(): number {
  const n = Number(process.env.EVOKEEPER_LLM_MIN_INTERVAL_MS ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 按 provider 串行排程：先占坑再等待，避免并发请求同时醒来又一起撞限流 */
async function pace(provider: string): Promise<void> {
  const gap = minIntervalMs();
  if (gap === 0) return;
  const now = Date.now();
  const slot = Math.max(now, providerNextAt.get(provider) ?? 0);
  providerNextAt.set(provider, slot + gap);
  const wait = slot - now;
  if (wait > 0) await sleep(wait);
}

export function createHttpTransport(options: HttpTransportOptions = {}): LlmTransport {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

  // 可选代理：设置 HTTPS_PROXY/HTTP_PROXY 时经代理出网。
  // 场景：中转站域名被本机代理 Fake-IP 劫持，直连超时，必须走代理端口。
  // 注意必须连 fetch 一起换成 undici 包的实现——Node 内置 fetch 与外部 undici
  // 的 ProxyAgent 是两套实例，dispatcher 传给内置 fetch 会被静默忽略。
  // 显式注入的 fetchImpl（测试 mock）优先级最高，代理只在默认 fetch 上生效。
  let proxiedFetchPromise: Promise<typeof fetch | null> | null = null;
  function resolveProxiedFetch(): Promise<typeof fetch | null> {
    if (options.fetchImpl) return Promise.resolve(null);
    if (!proxiedFetchPromise) {
      const proxyUrl =
        process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
      proxiedFetchPromise = (async () => {
        if (!proxyUrl) return null;
        try {
          const undici = await import("undici");
          const agent = new undici.ProxyAgent(proxyUrl);
          const proxied = ((
            input: Parameters<typeof undici.fetch>[0],
            init?: Parameters<typeof undici.fetch>[1],
          ) => undici.fetch(input, { ...init, dispatcher: agent })) as unknown as typeof fetch;
          return proxied;
        } catch {
          console.warn(`[llm] 设置了代理 ${proxyUrl} 但 undici 不可用，降级直连`);
          return null;
        }
      })();
    }
    return proxiedFetchPromise;
  }

  function resolveAuth(provider: Provider): string {
    const envName = PROVIDER_ENV_KEY[provider];
    const key = options.apiKeys?.[provider] ?? process.env[envName];
    if (!key) {
      throw new Error(`缺少 ${provider} 的 API Key：请设置环境变量 ${envName}`);
    }
    return `Bearer ${key}`;
  }

  async function chat(req: ChatRequest): Promise<ChatResponse> {
    const spec = getSpec(req.model);
    const base = getBaseUrl(spec.provider);
    const authorization = resolveAuth(spec.provider);
    const body: Record<string, unknown> = {
      model: req.model,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
      temperature: req.temperature ?? 0,
      max_tokens: req.maxOutputTokens ?? 1024,
      stream: false,
    };
    if (req.jsonMode && spec.jsonMode) {
      body.response_format = { type: "json_object" };
    }

    let lastError: unknown = null;
    const proxiedFetch = await resolveProxiedFetch();
    const doFetch = proxiedFetch ?? fetchImpl;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        await pace(spec.provider);
        const res = await doFetch(`${base}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization,
            // 部分中转站在 Cloudflare 后开启 bot 防护，无 UA 的纯机器请求会被 403
            "user-agent": "Mozilla/5.0 (compatible; evokeeper-llm/0.1)",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        // 429 / 5xx 可重试；4xx 直接失败（属于调用方错误，重试无意义）
        if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
          if (res.status === 429) {
            const cooldown = parseRateLimitCooldown(await res.text());
            if (cooldown !== null) {
              // 中转站频控：冷却窗口内的短退避必然再失败，按站点要求等待
              await sleep((cooldown + 5) * 1000);
              continue;
            }
          }
          await sleep(backoff(attempt));
          continue;
        }
        if (!res.ok) {
          // 4xx（除 429 已在上方处理）属于调用方/配置/余额问题，重试永远不会成功：
          // 打上标记让 catch 直接抛出，不再消耗退避时间（2026-10-31 教训）
          const err = new Error(`LLM 调用失败 ${res.status}: ${(await res.text()).slice(0, 200)}`);
          (err as Error & { fatal?: boolean }).fatal = true;
          throw err;
        }
        const json = (await res.json()) as ChatCompletionBody;
        const usage = json.usage ?? {};
        return {
          content: json.choices?.[0]?.message?.content ?? "",
          inputTokens: usage.prompt_tokens ?? 0,
          outputTokens: usage.completion_tokens ?? 0,
          cachedInputTokens:
            usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0,
        };
      } catch (err) {
        lastError = err;
        // 致命错误（余额/鉴权/渠道缺失）不重试：退避只会把一次失败拉长成几分钟
        if ((err as { fatal?: boolean }).fatal || isFatalLlmError(err)) break;
        if (attempt < maxRetries) await sleep(backoff(attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async function embed(req: EmbedRequest): Promise<EmbedResponse> {
    const spec = getSpec(req.model);
    const base = getBaseUrl(spec.provider);
    const authorization = resolveAuth(spec.provider);
    const proxiedFetch = await resolveProxiedFetch();
    const doFetch = proxiedFetch ?? fetchImpl;

    // 重试骨架与 chat 一致：429/5xx 可重试（含中转站冷却等待），其余直接失败
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        await pace(spec.provider);
        const res = await doFetch(`${base}/embeddings`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization,
            "user-agent": "Mozilla/5.0 (compatible; evokeeper-llm/0.1)",
          },
          body: JSON.stringify({ model: req.model, input: req.input }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
          if (res.status === 429) {
            const cooldown = parseRateLimitCooldown(await res.text());
            if (cooldown !== null) {
              await sleep((cooldown + 5) * 1000);
              continue;
            }
          }
          await sleep(backoff(attempt));
          continue;
        }
        if (!res.ok) {
          const err = new Error(`Embedding 调用失败 ${res.status}: ${(await res.text()).slice(0, 200)}`);
          (err as Error & { fatal?: boolean }).fatal = true;
          throw err;
        }
        const json = (await res.json()) as EmbeddingBody;
        const vectors: number[][] = [];
        for (const item of json.data ?? []) {
          if (item.embedding) vectors.push(item.embedding);
        }
        return { vectors, inputTokens: json.usage?.prompt_tokens ?? 0 };
      } catch (err) {
        lastError = err;
        // 致命错误（余额/鉴权/渠道缺失）不重试：退避只会把一次失败拉长成几分钟
        if ((err as { fatal?: boolean }).fatal || isFatalLlmError(err)) break;
        if (attempt < maxRetries) await sleep(backoff(attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  return { chat, embed };
}

/** 测试用：注入固定响应，无需联网 */
export function createMockTransport(handler: {
  chat?: (req: ChatRequest) => ChatResponse | Promise<ChatResponse>;
  embed?: (req: EmbedRequest) => EmbedResponse | Promise<EmbedResponse>;
}): LlmTransport {
  return {
    async chat(req) {
      if (!handler.chat) throw new Error("MockTransport 未提供 chat 处理器");
      return handler.chat(req);
    },
    async embed(req) {
      if (!handler.embed) throw new Error("MockTransport 未提供 embed 处理器");
      return handler.embed(req);
    },
  };
}
