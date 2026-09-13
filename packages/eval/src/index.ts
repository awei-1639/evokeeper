/**
 * W6 待实现：评测 harness（项目灵魂，红线 R1 的执行者）
 * - 加载 datasets/golden-set.dev.jsonl 与 golden-set.holdout.jsonl
 * - 对候选经验跑 dev + holdout 双评测，产出 EvalRun
 * - bootstrap 置信区间（重采样 ≥ 1000 次）→ GateDecision
 * - 对抗样本集（W8）作为门禁第 4 项检查
 */
export {};
