/**
 * 结构化输出：LLM 输出不可信，必须解析 + 校验后才能进入决策。
 *
 * 规则（design.md §3.2 / §3.4 / §9）：
 * - 校验失败 → 回吐错误做 1 次修复轮 → 仍失败则交给调用方 escalate，绝不静默降级；
 * - 无论成功失败都返回 meta（model / tokens / cost / 耗时），供 R3 写入 Trace；
 * - judge / consolidate 不缓存（TTL=0），保证评测可复现。
 */
import type { ModelConfig } from "@evokeeper/core";
import { isFatalLlmError } from "./errors";
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
  /** 实际发出的「带校验错误的修复轮」次数（0 表示没走到修复路径） */
  repairTurns: number;
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

/** 单次调用的总尝试上限（含首次）；修复轮占其中一次，不额外增加上限 */
const MAX_ATTEMPTS = 3;
/** 回吐给模型的违规原文上限，防畸形长输出把输入成本放大 */
const REPAIR_ECHO_MAX_CHARS = 800;

/**
 * 构造修复指令：把违规输出与具体校验错误回吐给模型，要求只改格式重出。
 * 回吐内容来自模型自身输出，属不可信数据——转义尖括号防其再次被当作标签解析（§3.2）。
 */
export function buildRepairNote(rawOutput: string, validationError: string): string {
  const echoed = rawOutput
    .trim()
    .slice(0, REPAIR_ECHO_MAX_CHARS)
    .replace(/</g, "＜")
    .replace(/>/g, "＞");
  return [
    "<previous_output>",
    echoed,
    "</previous_output>",
    "",
    `上次输出未通过格式校验：${validationError}`,
    "请只修正格式与字段问题，重新输出完整 JSON，不要解释，不要重复上面的错误写法。",
  ].join("\n");
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

  const meta = (cacheHit: boolean, attempts: number, repairTurns = 0): LlmStepMeta => ({
    model,
    promptVersion: args.promptVersion ?? null,
    inputTokens,
    outputTokens,
    costAmount: estimateCost({ model, inputTokens, cachedInputTokens, outputTokens }),
    durationMs: Date.now() - t0,
    startedAt,
    cacheHit,
    attempts,
    repairTurns,
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
  let repairTurns = 0;
  let repairNote: string | null = null;

  // 最多 3 次：pilot 实测 jsonMode 偶发空/非法响应（50 条中 4 条连续 2 次失败），
  // 2 次重试可把间歇性失败率压到可忽略；仅在失败路径多花调用，成功路径成本不变。
  // v1.25：校验失败不再原样重发——把违规输出与校验错误回吐一次（repair turn），
  // 否则模型只会犯同样的错（260 条基线实测 13/260 三次全失败）。
  for (let i = 1; i <= MAX_ATTEMPTS; i += 1) {
    attempts = i;
    try {
      const res = await ctx.transport.chat({
        model,
        system: args.system,
        user: repairNote === null ? args.user : `${args.user}\n\n${repairNote}`,
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
          meta: meta(false, attempts, repairTurns),
        };
      }
      error = validated.error;
      // 只在还有重试机会时构造修复指令，且最多一次（防畸形输出把成本拖成 3 倍）
      if (repairTurns === 0 && i < MAX_ATTEMPTS) {
        repairNote = buildRepairNote(res.content, validated.error);
        repairTurns += 1;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      // 余额/鉴权/渠道类错误：连试 3 次只会把一次失败拉长成 3 次超时，直接放弃
      if (isFatalLlmError(err)) break;
      // 传输层失败（超时/空响应）也要重试，但对它回吐错误信息没有意义
    }
  }

  return { ok: false, data: null, raw: lastRaw, error, meta: meta(false, attempts, repairTurns) };
}
