/**
 * EvoKeeper 领域模型
 *
 * 设计红线：
 * R1 任何经验(Experience)必须经过 EvalGate 裁决才能发布；
 * R2 Agent 动作仅限 TriageLabel / Comment / Escalate，见 ActionWhitelist；
 * R3 一切行为必须落到 Trace 上，并携带成本与版本号。
 */

// ---------- 分诊 ----------

/** 分诊标签白名单（R2：输出必须是以下枚举之一） */
export type TriageLabel =
  | "bug"
  | "feature"
  | "question"
  | "duplicate"
  | "needs-more-info"
  | "invalid";

export interface TriageResult {
  labels: TriageLabel[];
  /** 判断依据（会随评论回复给用户或仅留痕） */
  rationale: string;
  /** 置信度 0-1，低于阈值时强制 Escalate */
  confidence: number;
}

/** Agent 允许执行的全部动作（R2 白名单） */
export type AgentAction =
  | { kind: "addLabels"; labels: TriageLabel[] }
  | { kind: "comment"; body: string; quoteRefs: string[] }
  | { kind: "escalate"; reason: string };

// ---------- 轨迹（R3：一切行为的唯一事实来源） ----------

export interface TraceStep {
  seq: number;
  kind: "llm" | "tool" | "action" | "observation";
  /** 该步使用的 prompt 版本 */
  promptVersion: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  /** 美元或人民币计价的该步成本，由 llm-router 结算 */
  costAmount: number;
  /** 工具调用摘要（经 gateway 审计后的结果引用，不存原始大响应） */
  toolSummary: string | null;
  startedAt: string;
  durationMs: number;
}

export interface Trace {
  id: string;
  repo: string;
  issueNumber: number;
  /** 产生该轨迹的 Agent 版本（经验集版本 + 代码版本） */
  agentVersion: string;
  steps: TraceStep[];
  finalActions: AgentAction[];
  totalCost: number;
  totalTokens: number;
  startedAt: string;
  finishedAt: string;
}

/** 用户/维护者反应信号：失败判别的原始输入 */
export interface ReactionSignal {
  kind:
    | "maintainer_relabel"
    | "maintainer_correction_comment"
    | "issue_reopened"
    | "author_followup_unsatisfied"
    | "author_thanks"
    | "issue_closed_by_author"
    | "no_reaction";
  occurredAt: string;
  detail?: string;
}

export type FailureVerdict = "failure" | "success" | "unclear";

export interface JudgedTrace {
  trace: Trace;
  reactions: ReactionSignal[];
  verdict: FailureVerdict;
  /** 判别规则版本：判别器本身也要可评测、可回溯 */
  judgeRuleVersion: string;
  /** 人工抽检校准标记 */
  humanReviewed: boolean;
}

// ---------- 记忆（四类分层） ----------

export type MemoryKind = "episodic" | "semantic" | "procedural" | "preference";

export interface MemoryItem {
  id: string;
  repo: string;
  kind: MemoryKind;
  content: string;
  /** 证据链：指向支持的 JudgedTrace / issue 编号 */
  evidenceRefs: string[];
  confidence: number;
  /** 语义记忆可失效（如"X 功能在 v2 已废弃"） */
  validUntil: string | null;
  version: string;
  createdAt: string;
}

// ---------- 经验 CI/CD ----------

export type ExperienceType =
  | "skill" // 程序性技能文件（.md）
  | "prompt_patch" // prompt 片段修改
  | "memory_update" // 记忆条目新增/修订
  | "tool_request"; // 发现缺失工具（只登记，不自动创建）

export interface ExperienceCandidate {
  id: string;
  type: ExperienceType;
  repo: string;
  /** 归纳出的模式描述（一句话） */
  pattern: string;
  /** 具体变更内容：skill 正文 / prompt diff / 记忆条目 */
  content: string;
  /** 必须附证据链（红线 R1 的配套要求） */
  evidenceTraceIds: string[];
  /** 预期受益切片，如 labels=bug & topic=build-error */
  expectedSlice: string;
  /** 由哪个睡眠整理任务产出 */
  consolidationJobId: string;
  status: "proposed" | "evaluating" | "approved" | "rejected" | "released";
  createdAt: string;
}

export interface EvalMetrics {
  triageAccuracy: number;
  triageMacroF1: number;
  /** LLM-judge 五维均分（0-5） */
  answerQuality: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  costPerIssue: number;
  /** 对抗样本通过率（W8 起启用） */
  adversarialPassRate: number | null;
}

export interface EvalRun {
  id: string;
  candidateId: string | null;
  /** null 表示基线（当前线上版本） */
  baselineRunId: string | null;
  datasetVersion: string;
  split: "dev" | "holdout";
  metrics: EvalMetrics;
  /** bootstrap 95% 置信区间（主指标） */
  ci95: { lower: number; upper: number } | null;
  /** 逐条结果，供回溯与切片分析 */
  perCase: Array<{
    caseId: string;
    passed: boolean;
    triageCorrect: boolean | null;
    answerScore: number | null;
  }>;
  ranAt: string;
}

/** 门禁规则 v1（见计划书 §5.4，全部满足才可发布） */
export interface GateDecision {
  evalRunId: string;
  passed: boolean;
  checks: Array<{
    rule:
      | "dev_improvement_ge_2pt"
      | "ci95_lower_bound_gt_0"
      | "holdout_no_regression_ge_1pt"
      | "adversarial_no_worsening"
      | "cost_increase_le_10pct";
    passed: boolean;
    detail: string;
  }>;
  decidedAt: string;
}

export interface ReleaseVersion {
  version: string;
  candidateId: string;
  /** 发布内容快照：skill/prompt/memory 的完整 diff */
  diff: string;
  gateDecisionId: string;
  status: "canary" | "full" | "rolled_back";
  canaryScope: string | null;
  releasedAt: string;
  rollbackOf: string | null;
}
