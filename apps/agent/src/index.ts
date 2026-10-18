/**
 * Agent 执行器 —— design.md §3
 *
 * 当前进度（W2）：分诊链路跑通（提示词装配 → 结构化输出 → 校验 → 动作决策 → TraceStep）。
 * Inbox（webhook 接入 + eventId 幂等 + 重试）已实现：./inbox.ts + ./webhook-server.ts。
 * 尚未接入：GitHub 写动作执行（需 MCP 网关，W3+）、记忆/技能注入（W3/W5）、RAG 问答。
 *
 * 红线：R2 输出动作仅限 addLabels / comment / escalate；R3 每次调用必须产出可落库的 TraceStep。
 */
import type { AgentAction, TraceStep, TriageResult } from "@evokeeper/core";
import { createLlm, type Llm } from "@evokeeper/llm";
import {
  TRIAGE_PROMPT_VERSION,
  buildTriageMessages,
  parseTriage,
  hasInjectionSuspicion,
  type TriageInput,
} from "./triage";

export interface IssueEvent {
  repo: string;
  issueNumber: number;
  title: string;
  body: string;
  comments?: Array<{ author: string; body: string }>;
  rawLabels?: string[];
}

export interface HandleResult {
  actions: AgentAction[];
  steps: TraceStep[];
  triage: TriageResult | null;
  escalated: boolean;
}

/** 低于该置信度只转人工，不评论（design.md §3.3） */
export const CONFIDENCE_THRESHOLD = 0.5;
const MAX_LABELS = 2;

const NEEDS_MORE_INFO_TEMPLATE = `感谢反馈！为了定位问题，请补充以下信息：
1. 具体版本号（服务端 / 客户端）与部署方式；
2. 可复现的最小步骤；
3. 完整报错堆栈或相关日志（脱敏后贴出）。
补充后我会继续跟进。`;

const INVALID_TEMPLATE = `这条 issue 目前缺少可处理的信息，或包含与项目无关的内容。请按社区规范补充最小可复现信息后再提交；如是误发，可自行关闭。感谢理解。`;

/** 动作决策（纯函数，便于单测覆盖） */
export function decideActions(triage: TriageResult, event: IssueEvent): AgentAction[] {
  if (triage.confidence < CONFIDENCE_THRESHOLD) {
    return [
      {
        kind: "escalate",
        reason: `置信度 ${triage.confidence.toFixed(2)} 低于阈值 ${CONFIDENCE_THRESHOLD}`,
      },
    ];
  }

  const suspicious =
    hasInjectionSuspicion(event.title) || hasInjectionSuspicion(event.body);
  let labels = triage.labels.slice(0, MAX_LABELS);

  // duplicate 必须给出原 issue 号，否则降级为 question —— 绝不臆造引用
  if (labels.includes("duplicate")) {
    const ref = /#(\d+)/.exec(triage.rationale)?.[1];
    if (ref) {
      const actions: AgentAction[] = [{ kind: "addLabels", labels }];
      if (!suspicious) {
        actions.push({
          kind: "comment",
          body: `这条疑似与 #${ref} 重复，建议合并跟进；若不是同一问题，请补充说明差异点。`,
          quoteRefs: [`#${ref}`],
        });
      }
      return actions;
    }
    labels = labels.map((l) => (l === "duplicate" ? "question" : l));
  }

  const actions: AgentAction[] = [{ kind: "addLabels", labels }];
  // 命中注入嫌疑：照常分诊，但不输出任何可能被诱导的评论
  if (suspicious) return actions;

  if (labels.includes("needs-more-info")) {
    actions.push({ kind: "comment", body: NEEDS_MORE_INFO_TEMPLATE, quoteRefs: [] });
    return actions;
  }
  if (labels.includes("invalid")) {
    actions.push({ kind: "comment", body: INVALID_TEMPLATE, quoteRefs: [] });
    return actions;
  }
  return actions;
}

export interface HandleIssueEventDeps {
  llm?: Llm;
  /**
   * 相似 issue 检索器（W4）。传入后先检索再分诊，命中项注入 <similar_issues>。
   * 检索失败降级为空证据（留痕一条零成本 llm 步），不阻断分诊主链路。
   */
  similarSearch?: {
    search(event: IssueEvent): Promise<
      Array<{ issueNumber: number; title: string; snippet: string; score: number }>
    >;
    model: string;
  };
}

export async function handleIssueEvent(
  event: IssueEvent,
  deps: HandleIssueEventDeps = {}
): Promise<HandleResult> {
  const llm = deps.llm ?? createLlm();

  const steps: TraceStep[] = [];
  let similarIssues: TriageInput["similarIssues"] | undefined;
  if (deps.similarSearch) {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    let inputTokens = 0;
    try {
      similarIssues = await deps.similarSearch.search(event);
      // embed 输入 token 数无法从这里精确取回（检索器内部结算），留痕以 token=0 记录
      // 检索这一步的真实成本在检索器侧结算；这里以零成本步保证"检索必留痕"（R3）
      inputTokens = 0;
    } catch (err) {
      // 检索失败不阻断主链路：降级为无证据分诊（duplicate 自然无从输出）
      console.error(`[similar] 检索失败，降级为无证据分诊：${String(err)}`);
      similarIssues = [];
    }
    steps.push({
      seq: 1,
      kind: "tool",
      promptVersion: null,
      model: deps.similarSearch.model,
      inputTokens,
      outputTokens: 0,
      costAmount: 0,
      toolSummary: `similar-issues: ${similarIssues.length} hits`,
      startedAt,
      durationMs: Date.now() - t0,
    });
  }

  const { system, user } = buildTriageMessages({ ...event, similarIssues });

  const completion = await llm.json({
    purpose: "triage",
    promptVersion: TRIAGE_PROMPT_VERSION,
    system,
    user,
    validate: parseTriage,
  });

  // 无论成功失败都留痕（R3）：失败的调用同样消耗了成本，必须可归因
  const step: TraceStep = {
    seq: steps.length + 1,
    kind: "llm",
    promptVersion: completion.meta.promptVersion,
    model: completion.meta.model,
    inputTokens: completion.meta.inputTokens,
    outputTokens: completion.meta.outputTokens,
    costAmount: completion.meta.costAmount,
    toolSummary: null,
    startedAt: completion.meta.startedAt,
    durationMs: completion.meta.durationMs,
  };
  steps.push(step);

  if (!completion.ok || !completion.data) {
    return {
      actions: [{ kind: "escalate", reason: `分诊失败：${completion.error ?? "未知错误"}` }],
      steps,
      triage: null,
      escalated: true,
    };
  }

  const triage = completion.data;
  return {
    actions: decideActions(triage, event),
    steps,
    triage,
    escalated: false,
  };
}

export {
  TRIAGE_PROMPT_VERSION,
  buildTriageMessages,
  parseTriage,
  hasInjectionSuspicion,
} from "./triage";
export type { TriageInput } from "./triage";
