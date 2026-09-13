/**
 * W3 待实现：purpose → model 分级路由 + usage 结算（复用 OfferCraft 经验）
 * - purposes: triage(便宜快) / answer(中档主力) / judge(强模型) / consolidate(强模型)
 * - 每个 purpose 独立超时、输出上限、usage 记账
 * - 查询级决策缓存：相同 (purpose, 归一化输入) 直接命中缓存
 */
export type LlmPurpose = "triage" | "answer" | "judge" | "consolidate";
