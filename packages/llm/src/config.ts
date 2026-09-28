/**
 * 模型配置与计价 —— 对应 design.md §9.1
 *
 * 价格核验于 2026-09-14。注意：DeepSeek 自 2026-08-17 起实行峰谷定价
 * （高峰 09:00-12:00 / 14:00-18:00，其余时段为空闲价的一半），供应商随时可能再调价，
 * 改动这里必须递增 DEFAULT_MODEL_CONFIG.version（design.md §9.1：换模型=换行为）。
 */
import type { ModelConfig } from "@evokeeper/core";

export type LlmPurpose = "triage" | "answer" | "judge" | "consolidate" | "embed";

export type Provider = "deepseek" | "dashscope" | "zhipu";

export interface ModelSpec {
  provider: Provider;
  /** 每百万 token 的人民币单价（空闲价） */
  inputPerMTok: number;
  cachedInputPerMTok: number;
  outputPerMTok: number;
  /** 存在峰谷定价的模型：这些北京时间为高峰，价格翻倍 */
  peakHours?: number[];
  contextWindow: number;
  maxOutputTokens: number;
  /** 是否支持 response_format=json_object */
  jsonMode: boolean;
}

export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  version: "mc-1.0",
  routing: {
    triage: "deepseek-v4-flash",
    answer: "qwen3-max",
    judge: "glm-4.6",
    consolidate: "deepseek-v4-pro",
    embed: "text-embedding-v4",
  },
};

/** 人民币汇率按 1 USD ≈ 7.15 CNY 折算 GLM 的美元标价 */
export const MODEL_SPECS: Record<string, ModelSpec> = {
  "deepseek-v4-flash": {
    provider: "deepseek",
    inputPerMTok: 1.5,
    cachedInputPerMTok: 0.05,
    outputPerMTok: 4.5,
    peakHours: [9, 10, 11, 14, 15, 16, 17],
    contextWindow: 1_000_000,
    maxOutputTokens: 8192,
    jsonMode: true,
  },
  "deepseek-v4-pro": {
    provider: "deepseek",
    inputPerMTok: 4.5,
    cachedInputPerMTok: 0.15,
    outputPerMTok: 13.5,
    peakHours: [9, 10, 11, 14, 15, 16, 17],
    contextWindow: 1_000_000,
    maxOutputTokens: 8192,
    jsonMode: true,
  },
  "qwen3-max": {
    provider: "dashscope",
    inputPerMTok: 2.5,
    // 百炼上下文缓存折扣未核实，保守按原价计（宁可高估成本，不可低估）
    cachedInputPerMTok: 2.5,
    outputPerMTok: 10,
    contextWindow: 256_000,
    maxOutputTokens: 8192,
    jsonMode: true,
  },
  "glm-4.6": {
    provider: "zhipu",
    inputPerMTok: 4.3,
    cachedInputPerMTok: 0.79,
    outputPerMTok: 15.8,
    contextWindow: 205_000,
    maxOutputTokens: 8192,
    jsonMode: true,
  },
  "text-embedding-v4": {
    provider: "dashscope",
    inputPerMTok: 0.5,
    cachedInputPerMTok: 0.5,
    outputPerMTok: 0,
    contextWindow: 8192,
    maxOutputTokens: 0,
    jsonMode: false,
  },
};

export const PROVIDER_ENV_KEY: Record<Provider, string> = {
  deepseek: "DEEPSEEK_API_KEY",
  dashscope: "DASHSCOPE_API_KEY",
  zhipu: "ZHIPU_API_KEY",
};

export const PROVIDER_BASE_URL: Record<Provider, string> = {
  deepseek: "https://api.deepseek.com",
  dashscope: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  zhipu: "https://open.bigmodel.cn/api/paas/v4",
};

/**
 * base URL 解析：环境变量可按供应商覆盖（DEEPSEEK_BASE_URL / DASHSCOPE_BASE_URL /
 * ZHIPU_BASE_URL），支持中转站 / 自建 OpenAI 兼容代理——只需换地址与 Key，模型名不变时
 * ModelConfig 版本不变（同模型同行为，归因不受影响）。
 */
export function getBaseUrl(provider: Provider): string {
  const override = process.env[`${provider.toUpperCase()}_BASE_URL`]?.trim();
  if (override && override.length > 0) {
    // 中转站地址常以 /v1 结尾或裸域名，统一去掉尾部斜杠后由传输层拼接路径
    return override.replace(/\/+$/, "");
  }
  return PROVIDER_BASE_URL[provider];
}

/** 北京时间整点（0-23） */
export function beijingHour(at: Date = new Date()): number {
  return new Date(at.getTime() + 8 * 3600_000).getUTCHours();
}

export function isPeakHour(at: Date, spec: ModelSpec): boolean {
  if (!spec.peakHours) return false;
  return spec.peakHours.includes(beijingHour(at));
}

export function resolveModel(
  purpose: LlmPurpose,
  config: ModelConfig = DEFAULT_MODEL_CONFIG
): string {
  return config.routing[purpose];
}

export function getSpec(model: string): ModelSpec {
  const spec = MODEL_SPECS[model];
  if (!spec) {
    throw new Error(
      `未知模型 "${model}"：请先在 MODEL_SPECS 登记其规格与价格（design.md §9.1）`
    );
  }
  return spec;
}

export interface CostInput {
  model: string;
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  at?: Date;
}

/** 估算单次调用成本，返回人民币金额（元） */
export function estimateCost(input: CostInput): number {
  const spec = getSpec(input.model);
  const peakFactor = isPeakHour(input.at ?? new Date(), spec) ? 2 : 1;
  const cached = Math.max(0, input.cachedInputTokens ?? 0);
  const fresh = Math.max(0, input.inputTokens - cached);
  const output = Math.max(0, input.outputTokens ?? 0);
  const per = (tokens: number, unitPerMTok: number): number =>
    (tokens / 1_000_000) * unitPerMTok;
  return (
    (per(fresh, spec.inputPerMTok) +
      per(cached, spec.cachedInputPerMTok) +
      per(output, spec.outputPerMTok)) *
    peakFactor
  );
}

/** 批量任务应排到空闲时段（design.md §9.1 峰谷调度），返回当前是否空闲 */
export function isOffPeakNow(
  at: Date = new Date(),
  model: string = DEFAULT_MODEL_CONFIG.routing.triage
): boolean {
  return !isPeakHour(at, getSpec(model));
}
