/**
 * W5-W6 待实现：后台任务
 * - consolidate()      睡眠整理：失败轨迹聚类 → LLM 归纳 → ExperienceCandidate
 * - replay()           影子评估：候选经验在历史轨迹上离线回放
 * - runGate()          评测门禁：dev/holdout 双跑 → GateDecision
 * - release()          版本化发布：灰度 48h → 全量 / 回滚
 */
export async function consolidate(): Promise<void> {
  throw new Error("W5 实现：睡眠整理管线");
}
