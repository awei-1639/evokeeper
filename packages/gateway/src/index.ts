/**
 * 工具治理网关（W4 前置，真实 GitHub 写动作的唯一通道）—— design.md §3.3 / §9
 *
 * 职责（全部为纯函数判定，历史由调用方注入，保证可回放 R3）：
 * 1. 幂等键：`actionIdempotencyKey` = (repo, issueNumber, actionKind, contentHash)——
 *    webhook 重放导致的重复写在这里被拦下（重复键 → allowed=false, reason=replay）；
 * 2. 限流（§3.3 硬约束）：单次处理 addLabels ≤ 2 个标签、comment ≤ 1 条；
 *    同一 issue 24h 冷却期内不重复评论；
 * 3. 审计：每次判定产出 ToolAuditEntry（允许与否都留痕），调用方负责持久化。
 *
 * 注意：escalate 是转人工动作，不经网关（无外部写）。
 * 可独立开源的副产品定位不变：本包不依赖 agent/llm，只依赖 core 类型与 node:crypto。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentAction } from "@evokeeper/core";

export type { AgentAction } from "@evokeeper/core";

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

const DAY_MS = 86_400_000;
/** §3.3：单次处理最多 addLabels 2 个标签 + comment 1 条 */
export const MAX_LABELS_PER_RUN = 2;
export const MAX_COMMENTS_PER_RUN = 1;
/** §3.3：同一 issue 24h 冷却期内不重复评论 */
export const COMMENT_COOLDOWN_MS = DAY_MS;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/**
 * 幂等键（§9 契约）：(repo, issueNumber, actionKind, contentHash)。
 * 纯内容寻址——同一 issue 上相同内容的动作无论从哪个轨迹/哪次重放发起，键都相同，
 * 重放防护才真正生效（若混入 traceId，跨轨迹重复评论将绕过检测）。
 */
export function actionIdempotencyKey(
  repo: string,
  issueNumber: number,
  action: AgentAction
): string {
  const content =
    action.kind === "addLabels"
      ? [...action.labels].sort().join(",")
      : action.kind === "comment"
        ? action.body
        : action.reason;
  return `${repo}#${issueNumber}:${action.kind}:${sha256(content)}`;
}

function permissionOf(action: AgentAction): ToolPermission {
  return action.kind === "addLabels" ? "write-label" : "write-comment";
}

function argsSummaryOf(action: AgentAction): string {
  switch (action.kind) {
    case "addLabels":
      return `labels=[${[...action.labels].sort().join(",")}]`;
    case "comment":
      return `body=${action.body.slice(0, 80)}…`;
    case "escalate":
      return `reason=${action.reason.slice(0, 80)}`;
  }
}

export interface GatewayActionDecision {
  action: AgentAction;
  idempotencyKey: string;
  allowed: boolean;
  reason: string;
}

export interface EvaluateActionsInput {
  repo: string;
  issueNumber: number;
  traceId: string;
  actions: readonly AgentAction[];
  /** 该 issue 历史已落库的审计（含此前评论的时间戳，用于冷却判定） */
  history: readonly ToolAuditEntry[];
  now?: string;
}

/**
 * 写动作治理：重放去重 → 冷却限流 → 单次配额。
 * 每个动作都产出一条审计（allowed 与否），返回判定供调用方执行与留痕。
 */
export function evaluateActions(input: EvaluateActionsInput): {
  decisions: GatewayActionDecision[];
  auditEntries: ToolAuditEntry[];
} {
  const now = input.now ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  const decisions: GatewayActionDecision[] = [];
  const auditEntries: ToolAuditEntry[] = [];

  const seenKeys = new Set<string>();
  let labelCount = 0;
  let commentCount = 0;

  for (const action of input.actions) {
    const key = actionIdempotencyKey(input.repo, input.issueNumber, action);
    let allowed = true;
    let reason = "ok";

    // 1. 重放去重：同幂等键在历史或本批次中已出现 → 拒绝
    const replayed =
      seenKeys.has(key) ||
      input.history.some((e) => e.idempotencyKey === key && e.allowed);
    if (replayed) {
      allowed = false;
      reason = "replay：同幂等键已执行过（webhook 重放防护）";
    }

    // 2. 24h 评论冷却（用幂等键前缀定位历史评论，避免字符串摘要匹配）
    if (allowed && action.kind === "comment") {
      const keyPrefix = `${input.repo}#${input.issueNumber}:comment:`;
      const lastComment = input.history
        .filter((e) => e.allowed && e.idempotencyKey.startsWith(keyPrefix))
        .map((e) => Date.parse(e.at))
        .sort((a, b) => b - a)[0];
      if (lastComment !== undefined && nowMs - lastComment < COMMENT_COOLDOWN_MS) {
        allowed = false;
        reason = `cooldown：该 issue ${COMMENT_COOLDOWN_MS / 3_600_000}h 内已评论过`;
      }
    }

    // 3. 单次配额（§3.3）
    if (allowed && action.kind === "addLabels") {
      if (labelCount >= 1) {
        allowed = false;
        reason = `quota：单次处理最多 ${MAX_LABELS_PER_RUN} 个 addLabels 动作`;
      } else if (action.labels.length > MAX_LABELS_PER_RUN) {
        allowed = false;
        reason = `quota：单次 addLabels 最多 ${MAX_LABELS_PER_RUN} 个标签`;
      } else {
        labelCount++;
      }
    }
    if (allowed && action.kind === "comment") {
      if (commentCount >= MAX_COMMENTS_PER_RUN) {
        allowed = false;
        reason = `quota：单次处理最多 ${MAX_COMMENTS_PER_RUN} 条 comment`;
      } else {
        commentCount++;
      }
    }

    seenKeys.add(key);
    decisions.push({ action, idempotencyKey: key, allowed, reason });
    auditEntries.push({
      traceId: input.traceId,
      tool: action.kind,
      permission: permissionOf(action),
      argsSummary: `repo=${input.repo} issue=${input.issueNumber} ${argsSummaryOf(action)}`,
      resultSummary: allowed ? "accepted" : reason,
      idempotencyKey: key,
      allowed,
      at: now,
    });
  }

  return { decisions, auditEntries };
}

// ---------- 审计持久化（R3：允许与否都留痕） ----------

export interface AuditStore {
  append(entries: readonly ToolAuditEntry[]): Promise<void>;
  /** 某 issue 的历史审计（重放与冷却判定的输入） */
  listByIssue(repo: string, issueNumber: number): Promise<ToolAuditEntry[]>;
}

/** JSONL 落盘：一行一条审计，追加写入。W4 Postgres 版替换实现，接口不变。 */
export class JsonlAuditStore implements AuditStore {
  constructor(private readonly filePath: string) {
    mkdirSync(path.dirname(filePath), { recursive: true });
  }

  private load(): ToolAuditEntry[] {
    if (!existsSync(this.filePath)) return [];
    return readFileSync(this.filePath, "utf8")
      .trim()
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as ToolAuditEntry);
  }

  async append(entries: readonly ToolAuditEntry[]): Promise<void> {
    if (entries.length === 0) return;
    // 追加语义：直接 appendFileSync 会导致重复键的多次判定混入历史，
    // 这里按幂等键去重后整写（W4 规模足够；PG 版用唯一键 INSERT）
    const existing = this.load();
    const seen = new Set(existing.map((e) => `${e.idempotencyKey}:${e.at}`));
    const merged = [...existing, ...entries.filter((e) => !seen.has(`${e.idempotencyKey}:${e.at}`))];
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(
      tmp,
      merged.map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf8"
    );
    renameSync(tmp, this.filePath);
  }

  async listByIssue(repo: string, issueNumber: number): Promise<ToolAuditEntry[]> {
    const prefix = `${repo}#${issueNumber}:`;
    return this.load().filter((e) => e.idempotencyKey.startsWith(prefix));
  }
}
