/**
 * 反应信号采集器（W4-W5）—— design.md §5
 *
 * "每日扫描已处理 issue 的 webhook 事件，窗口 14 天，映射为 ReactionSignal"。
 * 输入：已处理 issue 的 GitHub 时间线（state 事件 + 评论）；
 * 输出：ReactionSignal 列表 → judgeTrace → JudgedTrace。
 *
 * v1 信号映射规则（启发式，provisional——判别器每周人工抽检校准，误标走 jrv 版本修订）：
 * 1. reopened 事件 → issue_reopened（显式失败，优先级 1）；
 * 2. labeled/unlabeled 事件且 actor ≠ bot → maintainer_relabel（维护者改了我们的标签）；
 * 3. 维护者侧（OWNER/MEMBER/COLLABORATOR 关联）评论且命中纠正线索 → maintainer_correction_comment；
 * 4. issue 作者评论命中感谢线索 → author_thanks；
 * 5. issue 作者在 Bot 处理后追问 ≥2 次且窗口内无维护者回应 → author_followup_unsatisfied；
 * 6. 窗口内无任何信号 → judgeTrace 判 unclear（不进整理管线）。
 *
 * Bot 的评论本身（以 actor=botLogin 排除）不产生信号。
 */
import type { ReactionSignal } from "@evokeeper/core";

/** 与 apps/agent 的 GithubClient 结构兼容（TS 结构化类型，无需跨包依赖） */
export interface ReactionClient {
  getIssue(
    repo: string,
    issueNumber: number
  ): Promise<{ state: "open" | "closed"; author: string; labels: string[]; updatedAt: string } | null>;
  listEvents(
    repo: string,
    issueNumber: number
  ): Promise<
    Array<{
      event: "labeled" | "unlabeled" | "closed" | "reopened" | "commented";
      actor: string;
      authorAssociation: string;
      label?: string;
      body?: string;
      createdAt: string;
    }>
  >;
}

export interface IssueSnapshot {
  state: "open" | "closed";
  /** issue 作者登录名 */
  author: string;
  labels: string[];
  updatedAt: string;
}

/** 归一化的 GitHub 时间线事件（/issues/{n}/events 的子集） */
export interface GithubEvent {
  event: "labeled" | "unlabeled" | "closed" | "reopened" | "commented";
  actor: string;
  /** 评论者的仓库关联（OWNER/MEMBER 视为维护者侧） */
  authorAssociation: "OWNER" | "MEMBER" | "COLLABORATOR" | "CONTRIBUTOR" | "NONE" | string;
  label?: string;
  body?: string;
  createdAt: string;
}

export interface ProcessedIssue {
  repo: string;
  issueNumber: number;
  /** Bot 处理完成时刻（只看此后的时间线） */
  processedAt: string;
  /** Bot 的登录名（排除自身动作） */
  botLogin: string;
}

const THANKS_CUES = /谢谢|感谢|thanks?\b|worked|解决了|有效|fixed it/i;
const CORRECTION_CUES = /不对|不正确|不是这样|误解|其实|应该是|更正|wrong|incorrect|not (?:quite )?right|actually|misdetect/i;

/** 维护者侧关联（GitHub 评论 association 字段） */
const MAINTAINER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/**
 * 时间线 → 信号映射（纯函数，单测全覆盖）。
 * issue 快照用于判断"作者关闭"（closed 事件 actor == author）。
 */
export function mapToSignals(
  issue: IssueSnapshot,
  events: readonly GithubEvent[],
  processed: ProcessedIssue
): ReactionSignal[] {
  const signals: ReactionSignal[] = [];
  const since = Date.parse(processed.processedAt);

  for (const e of events) {
    const at = Date.parse(e.createdAt);
    if (Number.isNaN(at) || at < since) continue; // 只看处理之后
    if (e.actor === processed.botLogin) continue; // Bot 自身动作不算反应

    if (e.event === "reopened") {
      signals.push({ kind: "issue_reopened", occurredAt: e.createdAt, detail: `reopened by ${e.actor}` });
      continue;
    }
    if ((e.event === "labeled" || e.event === "unlabeled") && e.label) {
      signals.push({
        kind: "maintainer_relabel",
        occurredAt: e.createdAt,
        detail: `${e.event} ${e.label} by ${e.actor}`,
      });
      continue;
    }
    if (e.event === "closed" && e.actor === issue.author) {
      signals.push({ kind: "issue_closed_by_author", occurredAt: e.createdAt, detail: "closed by author" });
      continue;
    }
    if (e.event === "commented") {
      const maintainerSide = MAINTAINER_ASSOCIATIONS.has(e.authorAssociation);
      if (maintainerSide && CORRECTION_CUES.test(e.body ?? "")) {
        signals.push({
          kind: "maintainer_correction_comment",
          occurredAt: e.createdAt,
          detail: `${e.actor}: ${(e.body ?? "").slice(0, 120)}`,
        });
        continue;
      }
      if (e.actor === issue.author) {
        if (THANKS_CUES.test(e.body ?? "")) {
          signals.push({ kind: "author_thanks", occurredAt: e.createdAt, detail: (e.body ?? "").slice(0, 120) });
          continue;
        }
        // 作者追问：非感谢、非维护者的正文评论（unsatisfied 判定看数量，见规则 5）
        signals.push({
          kind: "author_followup_unsatisfied",
          occurredAt: e.createdAt,
          detail: `followup: ${(e.body ?? "").slice(0, 120)}`,
        });
      }
    }
  }

  // 规则 5：作者追问 < 2 次不足以判 unsatisfied——从候选中剔除孤立追问
  const followups = signals.filter((s) => s.kind === "author_followup_unsatisfied");
  if (followups.length > 0 && followups.length < 2) {
    return signals.filter((s) => s.kind !== "author_followup_unsatisfied");
  }
  return signals;
}

export interface ScanResult {
  issueNumber: number;
  signals: ReactionSignal[];
  /** 交由调用方执行 judgeTrace 并落 JudgedTrace */
}

/**
 * 扫描一批已处理 issue：拉时间线 → 映射信号。
 * 调用方随后用 judgeTrace 生成 JudgedTrace（unclear 自然不进整理管线）。
 */
export async function scanReactions(
  client: ReactionClient,
  processed: readonly ProcessedIssue[]
): Promise<ScanResult[]> {
  const results: ScanResult[] = [];
  for (const p of processed) {
    const issue = await client.getIssue(p.repo, p.issueNumber);
    if (!issue) {
      results.push({ issueNumber: p.issueNumber, signals: [] });
      continue;
    }
    const events = await client.listEvents(p.repo, p.issueNumber);
    results.push({ issueNumber: p.issueNumber, signals: mapToSignals(issue, events, p) });
  }
  return results;
}
