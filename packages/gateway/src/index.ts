/**
 * W8 待实现：MCP 工具治理网关（可独立开源的副产品）
 * - 权限分级：read-public / write-comment / write-label，各自最小化
 * - 每次调用审计：谁、何时、什么工具、什么参数、结果摘要
 * - 限流熔断 + 幂等键（防止 webhook 重放导致重复评论）
 */
export type ToolPermission = "read-public" | "write-comment" | "write-label";

export interface ToolAuditEntry {
  traceId: string;
  tool: string;
  permission: ToolPermission;
  argsSummary: string;
  resultSummary: string;
  idempotencyKey: string;
  allowed: boolean;
  at: string;
}
