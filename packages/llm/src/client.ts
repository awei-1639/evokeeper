/**
 * LLM 传输层：三家供应商（DeepSeek / 百炼 / 智谱）均提供 OpenAI 兼容端点，
 * 因此统一用一个 OpenAI 兼容客户端覆盖 —— design.md §9.1 的选型可直接切换。
 *
 * 传输层与业务逻辑解耦：测试用 createMockTransport 注入，无需联网与 API Key。
 */
import { PROVIDER_ENV_KEY, getBaseUrl, getSpec, type Provider } from "./config";

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
function parseRateLimitCooldown(body: string): number | null {
  const m = /请等待\s*(\d+)\s*秒/.exec(body);
  if (!m || !m[1]) return null;
  return Math.min(Number(m[1]), 900);
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
          throw new Error(`LLM 调用失败 ${res.status}: ${(await res.text()).slice(0, 200)}`);
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
    const res = await (proxiedFetch ?? fetchImpl)(`${base}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify({ model: req.model, input: req.input }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`Embedding 调用失败 ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const json = (await res.json()) as EmbeddingBody;
    const vectors: number[][] = [];
    for (const item of json.data ?? []) {
      if (item.embedding) vectors.push(item.embedding);
    }
    return { vectors, inputTokens: json.usage?.prompt_tokens ?? 0 };
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
