/**
 * 模型配置与计价 —— 对应 design.md §9.1
 *
 * 价格核验于 2026-09-14。注意：DeepSeek 自 2026-08-17 起实行峰谷定价
 * （高峰 09:00-12:00 / 14:00-18:00，其余时段为空闲价的一半），供应商随时可能再调价，
 * 改动这里必须递增 DEFAULT_MODEL_CONFIG.version（design.md §9.1：换模型=换行为）。
 */
import type { ModelConfig } from "@evokeeper/core";

export type LlmPurpose = "triage" | "answer" | "judge" | "consolidate" | "embed";

export type Provider = "deepseek" | "dashscope" | "zhipu" | "siliconflow";

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

/**
 * mc-1.3：triage 通道切到 SiliconFlow 的 deepseek-ai/DeepSeek-V4-Flash（**同一底层模型**）。
 *
 * 为什么必须切：xxs 中转站 2026-10-31 起已无任何可用 chat 渠道——
 *   v4-flash → 503 model_not_found（"No available channel ... under group 稳定"）；
 *   gpt-6-luna → 500 upstream error，重试后变 400 unknown provider。
 *   官方端点 api.deepseek.com 对本站 key 返回 401 Authentication Fails（余额问题不存在，是渠道没了）。
 *
 * 为什么算"换通道"不算"换模型"：fidelity-check 40 条（stride=4, limit=40）实测
 *   双方有效 35 条中预测一致 **32 条 = 91%** ≥ 90% 线；分歧 8 条里 4 条是官方自身解析 FAIL
 *   而中转判对，真实判定差异仅 4 条（均为边界样本）。
 *   判据与 2026-10-17 公益站那次（同 91%）一致。
 *
 * 代价：SiliconFlow 高峰价为官方 2 倍（¥3/¥9 vs ¥1.5/¥4.5），低谷同价；时段划分也不同。
 * 遗留：mc-1.2 的注释（v4.1-flash 路由）已在 f59b234 回滚，本版本号跳过 1.2 不复用。
 */
export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  version: "mc-1.3",
  routing: {
    triage: "deepseek-ai/DeepSeek-V4-Flash",
    answer: "qwen3-max",
    judge: "glm-4.6",
    consolidate: "deepseek-v4-pro",
    embed: "BAAI/bge-m3",
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
  /**
   * deepseek-ai/DeepSeek-V4-Flash（SiliconFlow 提供的**同名模型**通道别名）。
   *
   * 背景（2026-10-31）：xxs 中转站 v4-flash 渠道下线（503 model_not_found），
   * gpt-6-luna 也报 unknown provider，该站已无任何可用 chat 渠道；
   * SiliconFlow 上可调用同一底层模型，仅命名带前缀。
   *
   * 纪律位置：这是**换通道、不换模型**。是否等价由 fidelity-check 的逐条一致率裁定
   * （≥90% 才认通道等价，届时 mc 版本不变；<90% 则按换模型处理，递增版本并重跑基线）。
   * 计价按 SiliconFlow 公开价登记（2026-10-31 官网价目）：
   * 低谷（2:00–8:00）¥1.5 in / ¥4.5 out / ¥0.15 cached，**与官方 v4-flash 低谷价一致**；
   * 高峰（0:00–2:00、8:00–24:00）¥3.0 / ¥9.0 / ¥0.30 = 低谷 ×2。
   * 故基础价取低谷值 + peakHours 表达翻倍，与官方口径可直接比较。
   * 注意：**时段划分与官方不同**（官方高峰 9-12/14-18），跨通道比成本时必须按各自身份换算。
   */
  "deepseek-ai/DeepSeek-V4-Flash": {
    provider: "siliconflow",
    inputPerMTok: 1.5,
    cachedInputPerMTok: 0.15,
    outputPerMTok: 4.5,
    peakHours: [0, 1, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23],
    contextWindow: 1_000_000,
    maxOutputTokens: 8192,
    jsonMode: true,
  },
  "deepseek-v4.1-flash": {
    // 中转站计价不透明，实测 ~＄0.002/条分诊调用；价目暂沿用 v4-flash，待官方渠道核验后修正
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
    provider: "deepseek",
    inputPerMTok: 0.5,
    cachedInputPerMTok: 0.5,
    outputPerMTok: 0,
    contextWindow: 8192,
    maxOutputTokens: 0,
    jsonMode: false,
  },
  /**
   * BAAI/bge-m3（SiliconFlow 免费档）—— mc-1.1 起的 embed 默认。
   * 1024 维（与 design.md §9.1 维度约定、infra/migrations vector(1024) 一致），
   * 8192 token 上下文。免费档计价按 0 登记限速额度内（超出再修正）。
   */
  "BAAI/bge-m3": {
    provider: "siliconflow",
    inputPerMTok: 0,
    cachedInputPerMTok: 0,
    outputPerMTok: 0,
    contextWindow: 8192,
    maxOutputTokens: 0,
    jsonMode: false,
  },
  /**
   * claude-opus-4-8（用户中转站提供）——transport 走 DEEPSEEK_BASE_URL 指向的中转站
   * （provider 字段在此仅决定"用哪组环境变量取 base URL 与 Key"）。
   * 计价按 Opus 级官方价保守登记（$15/$75 × 7.15）；**中转站实际单价可能更低，
   * 拿到中转站价目后必须修正此表**（宁可高估成本，不可低估）。
   * jsonMode=false：Claude 原生无 response_format=json_object，中转站翻译行为不一，
   * 关闭后依赖提示词纪律 + extractJson 兜底。
   */
  "claude-opus-4-8": {
    provider: "deepseek",
    inputPerMTok: 107.25,
    cachedInputPerMTok: 107.25,
    outputPerMTok: 536.25,
    contextWindow: 200_000,
    maxOutputTokens: 8192,
    jsonMode: false,
  },
};

export const PROVIDER_ENV_KEY: Record<Provider, string> = {
  deepseek: "DEEPSEEK_API_KEY",
  dashscope: "DASHSCOPE_API_KEY",
  zhipu: "ZHIPU_API_KEY",
  siliconflow: "SILICONFLOW_API_KEY",
};

export const PROVIDER_BASE_URL: Record<Provider, string> = {
  deepseek: "https://api.deepseek.com",
  dashscope: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  zhipu: "https://open.bigmodel.cn/api/paas/v4",
  siliconflow: "https://api.siliconflow.cn/v1",
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

/** 各档的降级备选（§9.1：无 Key 时按序降级，替换必须如实记录在轨迹/报告里） */
export const PURPOSE_FALLBACK: Partial<Record<LlmPurpose, string>> = {
  answer: "deepseek-v4-pro",
  judge: "deepseek-v4-pro",
};

/**
 * 线上运行时的模型配置：按环境可用性降级（§9.1"备选如实记录"）。
 * 某档模型所属 provider 无 Key 时切换到备选并 log。
 * - 轨迹 TraceStep 记录的是真实模型（R3），降级不会"冒充"原模型；
 * - 评测不受影响：评测 runner 自带 config，不走本函数；
 * - config.version 不变：这是环境适配不是行为变更（换模型重评的纪律针对评测基线）。
 */
export function liveModelConfigFromEnv(log: (msg: string) => void = () => {}): ModelConfig {
  const routing = { ...DEFAULT_MODEL_CONFIG.routing };
  for (const [purpose, model] of Object.entries(routing) as Array<[LlmPurpose, string]>) {
    const fallback = PURPOSE_FALLBACK[purpose];
    if (!fallback || model === fallback) continue;
    const provider = MODEL_SPECS[model]?.provider;
    if (provider && !process.env[PROVIDER_ENV_KEY[provider]]) {
      routing[purpose] = fallback;
      log(`[llm] ${purpose} 档 ${model} 无 ${PROVIDER_ENV_KEY[provider]}，按 §9.1 降级为 ${fallback}`);
    }
  }
  return { ...DEFAULT_MODEL_CONFIG, routing };
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
