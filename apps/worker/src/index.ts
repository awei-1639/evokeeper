/**
 * @evokeeper/worker —— 后台任务：失败判别 / 睡眠整理 / 影子回放 / 发布回滚
 *
 * 模块清单（各文件头部有设计依据与约束说明）：
 * - judge.ts             失败判别器 jrv-1.0（unclear 不进整理管线）
 * - consolidate.ts       睡眠整理管线（聚类 + cp-1.0 归纳 → ExperienceCandidate）
 * - shadow-replay.ts     第 6 道门禁：历史轨迹影子回放
 * - release.ts           §8 发布状态机（灰度裁决 / O(1) 回滚）
 * - candidate-store.ts   候选经验评审队列（JSONL 持久化）
 * - reaction-collector.ts 反应信号采集（每日扫描 → ReactionSignal）
 */
export * from "./judge";
export * from "./consolidate";
export * from "./shadow-replay";
export * from "./release";
export * from "./candidate-store";
export * from "./reaction-collector";
