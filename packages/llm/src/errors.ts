/**
 * LLM 调用错误分类（2026-10-31）
 *
 * 动机：一次「通道余额耗尽」被当成瞬时故障处理，代价是 52 分钟墙钟——
 * 每条 case 依次重试 3 次（structured）+ 30/60/120s 退避（run-eval），
 * 260 条里跑了十几条就过去了一小时，且报告最终不会落盘。
 *
 * 判据：**配置/凭据/余额类错误无论重试多少次都不会成功**，必须立刻中止；
 * 只有 429（频控）与 5xx（上游抖动）值得重试。这里把这条区分写成
 * 一个可复用的判定，避免「注释说 4xx 不重试、代码却在重试」这类漂移
 * （client.ts 原注释与实现就是这样不一致的）。
 */

/** 余额/鉴权/渠道配置类错误：重试无意义，必须立即中止整批任务 */
export const FATAL_LLM_ERROR_PATTERNS: RegExp[] = [
  /\b401\b/, // 鉴权失败
  /\b402\b/, // 余额不足
  /insufficient[\s_-]*(balance|quota|user)/i, // OpenAI 风格 / SiliconFlow code 30001
  /authentication\s*fails?/i,
  /invalid\s*token/i,
  /unknown\s*provider/i, // 中转站渠道未配置
  /model_not_found/i,
  /no\s*available\s*channel/i,
];

export interface LlmFatalInfo {
  fatal: boolean;
  /** 命中的模式（用于日志与报告，不含密钥） */
  matched: string | null;
}

export function classifyLlmError(err: unknown): LlmFatalInfo {
  const text = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  for (const p of FATAL_LLM_ERROR_PATTERNS) {
    if (p.test(text)) return { fatal: true, matched: p.source };
  }
  return { fatal: false, matched: null };
}

/** 便捷判断：true 表示应立刻中止而不是退避重试 */
export function isFatalLlmError(err: unknown): boolean {
  return classifyLlmError(err).fatal;
}
