/**
 * 结构化输出：LLM 输出不可信，必须解析 + 校验后才能进入决策。
 *
 * 规则（design.md §3.2 / §9）：
 * - 校验失败 → 重试 1 次 → 仍失败则交给调用方 escalate，绝不静默降级；
 * - 无论成功失败都返回 meta（model / tokens / cost / 耗时），供 R3 写入 Trace；
 * - judge / consolidate 不缓存（TTL=0），保证评测可复现。
 */
import type { ModelConfig } from "@evokeeper/core";
import { DEFAULT_TTL_MS, buildCacheKey, type LlmCache } from "./cache";
import { estimateCost, resolveModel, type LlmPurpose } from "./config";
import type { LlmTransport } from "./client";

export interface LlmStepMeta {
  model: string;
  promptVersion: string | null;
  inputTokens: number;
  outputTokens: number;
  costAmount: number;
  durationMs: number;
  startedAt: string;
  cacheHit: boolean;
  attempts: number;
}

export interface JsonCompletion<T> {
  ok: boolean;
  data: T | null;
  raw: string;
  error: string | null;
  meta: LlmStepMeta;
}

export type Validator<T> = (
  parsed: unknown
) => { ok: true; value: T } | { ok: false; error: string };

export interface CompleteJsonArgs<T> {
  purpose: LlmPurpose;
  system: string;
  user: string;
  promptVersion?: string | null;
  temperature?: number;
  maxOutputTokens?: number;
  validate: Validator<T>;
  ttlMs?: number;
  /** 覆盖路由模型（评测对比不同模型时使用） */
  model?: string;
}

export interface LlmContext {
  config: ModelConfig;
  transport: LlmTransport;
  cache: LlmCache | null;
}

/** 从可能被 ```json 包裹或带前后废话的输出中提取 JSON */
export function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    // 退化：截取第一个 { 到最后一个 }
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

export async function completeJson<T>(
  ctx: LlmContext,
  args: CompleteJsonArgs<T>
): Promise<JsonCompletion<T>> {
  const model = args.model ?? resolveModel(args.purpose, ctx.config);
  const ttl = args.ttlMs ?? DEFAULT_TTL_MS[args.purpose] ?? 0;
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;

  const meta = (cacheHit: boolean, attempts: number): LlmStepMeta => ({
    model,
    promptVersion: args.promptVersion ?? null,
    inputTokens,
    outputTokens,
    costAmount: estimateCost({ model, inputTokens, cachedInputTokens, outputTokens }),
    durationMs: Date.now() - t0,
    startedAt,
    cacheHit,
    attempts,
  });

  if (ctx.cache && ttl > 0) {
    const key = buildCacheKey({
      configVersion: ctx.config.version,
      purpose: args.purpose,
      model,
      system: args.system,
      user: args.user,
    });
    const hit = await ctx.cache.get(key);
    if (hit !== null) {
      const validated = args.validate(extractJson(hit));
      if (validated.ok) {
        return { ok: true, data: validated.value, raw: hit, error: null, meta: meta(true, 0) };
      }
    }
  }

  let lastRaw = "";
  let error: string | null = null;
  let attempts = 0;

  // 最多 3 次：pilot 实测 jsonMode 偶发空/非法响应（50 条中 4 条连续 2 次失败），
  // 2 次重试可把间歇性失败率压到可忽略；仅在失败路径多花调用，成功路径成本不变。
  for (let i = 1; i <= 3; i += 1) {
    attempts = i;
    try {
      const res = await ctx.transport.chat({
        model,
        system: args.system,
        user: args.user,
        temperature: args.temperature ?? 0,
        maxOutputTokens: args.maxOutputTokens,
        jsonMode: true,
      });
      lastRaw = res.content;
      inputTokens += res.inputTokens;
      outputTokens += res.outputTokens;
      cachedInputTokens += res.cachedInputTokens;

      const validated = args.validate(extractJson(res.content));
      if (validated.ok) {
        if (ctx.cache && ttl > 0) {
          const key = buildCacheKey({
            configVersion: ctx.config.version,
            purpose: args.purpose,
            model,
            system: args.system,
            user: args.user,
          });
          await ctx.cache.set(key, res.content, ttl);
        }
        return {
          ok: true,
          data: validated.value,
          raw: res.content,
          error: null,
          meta: meta(false, attempts),
        };
      }
      error = validated.error;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  return { ok: false, data: null, raw: lastRaw, error, meta: meta(false, attempts) };
}
