/**
 * @evokeeper/llm —— 模型分级路由 + 结构化输出 + usage 成本结算
 *
 * 对应 design.md §9 / §9.1：
 * - purpose 分五档（triage / answer / judge / consolidate / embed），分档选模型；
 * - 模型配置走 ModelConfig 版本快照（换模型 = 换行为，必须递增 version）；
 * - 每次调用返回可写入 TraceStep 的 meta（model / tokens / cost，红线 R3）；
 * - 批量调用前可用 isOffPeakNow() 判断空闲时段（DeepSeek 峰谷定价可省 50%）。
 */
import type { ModelConfig } from "@evokeeper/core";

export * from "./config";
export * from "./cache";
export * from "./client";
export * from "./structured";

import { DEFAULT_MODEL_CONFIG, estimateCost, resolveModel, type CostInput } from "./config";
import { createMemoryCache, type LlmCache } from "./cache";
import { createHttpTransport, type LlmTransport } from "./client";
import { completeJson, type CompleteJsonArgs, type JsonCompletion } from "./structured";

export interface LlmOptions {
  config?: ModelConfig;
  transport?: LlmTransport;
  /** 传 null 关闭缓存；默认进程内缓存（Redis 版待 infra 就绪） */
  cache?: LlmCache | null;
}

export interface Llm {
  readonly config: ModelConfig;
  readonly transport: LlmTransport;
  json<T>(args: CompleteJsonArgs<T>): Promise<JsonCompletion<T>>;
  embed(input: string[]): Promise<{ vectors: number[][]; model: string; costAmount: number }>;
  estimate(input: CostInput): number;
}

export function createLlm(options: LlmOptions = {}): Llm {
  const config = options.config ?? DEFAULT_MODEL_CONFIG;
  const transport = options.transport ?? createHttpTransport();
  const cache = options.cache === undefined ? createMemoryCache() : options.cache;

  return {
    config,
    transport,
    json: <T,>(args: CompleteJsonArgs<T>) => completeJson({ config, transport, cache }, args),
    async embed(input: string[]) {
      const model = resolveModel("embed", config);
      const res = await transport.embed({ model, input });
      return {
        vectors: res.vectors,
        model,
        costAmount: estimateCost({ model, inputTokens: res.inputTokens }),
      };
    },
    estimate: (input: CostInput) => estimateCost(input),
  };
}
