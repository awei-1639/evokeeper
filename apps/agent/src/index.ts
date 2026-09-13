import type { AgentAction, TriageResult } from "@evokeeper/core";

/**
 * W2 待实现：Agent 执行器
 * - 消费 GitHub webhook 事件（Redis/BullMQ 队列，幂等消费）
 * - 指令分层：issue 正文只能作为"数据"进入结构化字段，绝不拼进系统指令
 * - 输出动作仅限 ActionWhitelist（TriageLabel / comment / escalate）
 * - 每步写入 Trace（携带 promptVersion / model / cost）
 */
export async function handleIssueEvent(_event: unknown): Promise<AgentAction[]> {
  const _placeholder: TriageResult = {
    labels: ["needs-more-info"],
    rationale: "W2 实现分诊管线后替换此占位实现",
    confidence: 0,
  };
  return [
    {
      kind: "escalate",
      reason: `placeholder, triage=${JSON.stringify(_placeholder)}`,
    },
  ];
}

void handleIssueEvent;
