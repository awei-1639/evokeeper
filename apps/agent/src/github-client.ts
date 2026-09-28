/**
 * GitHub 客户端与写动作执行器（W4 前置）—— design.md §2 / §3.3
 *
 * 职责边界（§2）：GitHub 通道只做"动作执行"，不含业务判断；
 * 动作决策在 agent，治理在 gateway（evaluateActions），这里只执行放行的动作。
 *
 * 两个实现：
 * - RestGithubClient：真实 REST 调用（零依赖 fetch）。读公开数据零 scope token 即可；
 *   写动作需要 GitHub App（issues:write）或相应权限的 token，403 时如实返回错误。
 * - DryRunGithubClient：评测/影子回放用，不产生任何外部写（§7.1 dry-run 要求）。
 *
 * 凭据就绪前的接线方式：W4 真实流量启动时把 RestGithubClient 换入 executeActions，
 * 接口不变。
 */
import type { AgentAction } from "@evokeeper/core";
import { evaluateActions, JsonlAuditStore, type AuditStore, type ToolAuditEntry } from "@evokeeper/gateway";

const GITHUB_API = "https://api.github.com";

export interface GithubClient {
  /** POST /labels：追加标签（不覆盖已有标签） */
  addLabels(repo: string, issueNumber: number, labels: string[]): Promise<{ ok: boolean; detail: string }>;
  addComment(repo: string, issueNumber: number, body: string): Promise<{ ok: boolean; detail: string }>;
  getIssue(repo: string, issueNumber: number): Promise<IssueSnapshot | null>;
  listEvents(repo: string, issueNumber: number): Promise<GithubEvent[]>;
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

export class RestGithubClient implements GithubClient {
  constructor(
    private readonly token: string,
    private readonly apiBase = GITHUB_API
  ) {}

  private async request(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; json: unknown }> {
    const res = await fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "User-Agent": "evokeeper-agent",
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const json = res.status === 204 ? null : ((await res.json().catch(() => null)) as unknown);
    return { ok: res.ok, status: res.status, json };
  }

  async addLabels(repo: string, issueNumber: number, labels: string[]) {
    const r = await this.request("POST", `/repos/${repo}/issues/${issueNumber}/labels`, { labels });
    return { ok: r.ok, detail: r.ok ? `labels+=[${labels.join(",")}]` : `HTTP ${r.status}` };
  }

  async addComment(repo: string, issueNumber: number, body: string) {
    const r = await this.request("POST", `/repos/${repo}/issues/${issueNumber}/comments`, { body });
    return { ok: r.ok, detail: r.ok ? "commented" : `HTTP ${r.status}` };
  }

  async getIssue(repo: string, issueNumber: number): Promise<IssueSnapshot | null> {
    const r = await this.request("GET", `/repos/${repo}/issues/${issueNumber}`);
    if (!r.ok || typeof r.json !== "object" || r.json === null) return null;
    const j = r.json as Record<string, unknown>;
    return {
      state: j["state"] === "closed" ? "closed" : "open",
      author: (j["user"] as Record<string, unknown> | undefined)?.login as string | undefined ?? "unknown",
      labels: Array.isArray(j["labels"])
        ? j["labels"].map((l) => (typeof l === "object" && l !== null ? String((l as Record<string, unknown>).name ?? "") : String(l)))
        : [],
      updatedAt: typeof j["updated_at"] === "string" ? (j["updated_at"] as string) : "",
    };
  }

  async listEvents(repo: string, issueNumber: number): Promise<GithubEvent[]> {
    const r = await this.request("GET", `/repos/${repo}/issues/${issueNumber}/events?per_page=100`);
    if (!r.ok || !Array.isArray(r.json)) return [];
    return (r.json as Array<Record<string, unknown>>).map((e) => ({
      event: String(e["event"]) as GithubEvent["event"],
      actor: ((e["actor"] as Record<string, unknown> | undefined)?.login as string) ?? "unknown",
      authorAssociation: "NONE",
      label:
        typeof e["label"] === "object" && e["label"] !== null
          ? String((e["label"] as Record<string, unknown>).name ?? "")
          : undefined,
      createdAt: String(e["created_at"] ?? ""),
    }));
  }
}

/** 评测与影子回放专用：记录调用但不产生外部写（§7.1） */
export class DryRunGithubClient implements GithubClient {
  readonly calls: Array<{ method: string; repo: string; issueNumber: number; payload: unknown }> = [];

  async addLabels(repo: string, issueNumber: number, labels: string[]) {
    this.calls.push({ method: "addLabels", repo, issueNumber, payload: labels });
    return { ok: true, detail: `dry-run: labels+=[${labels.join(",")}]` };
  }

  async addComment(repo: string, issueNumber: number, body: string) {
    this.calls.push({ method: "addComment", repo, issueNumber, payload: body });
    return { ok: true, detail: "dry-run: commented" };
  }

  async getIssue(): Promise<IssueSnapshot | null> {
    return null;
  }

  async listEvents(): Promise<GithubEvent[]> {
    return [];
  }
}

// ---------- 写动作执行器 ----------

export interface ExecuteActionsResult {
  executed: Array<{ action: AgentAction; ok: boolean; detail: string }>;
  auditEntries: ToolAuditEntry[];
}

/**
 * 动作执行：先过 gateway 治理（幂等/冷却/配额），放行的才触达 GitHub。
 * history 是该 issue 既往审计（调用方从审计存储读入），用于重放与冷却判定。
 */
export async function executeActions(args: {
  repo: string;
  issueNumber: number;
  traceId: string;
  actions: readonly AgentAction[];
  history: readonly ToolAuditEntry[];
  github: GithubClient;
  /** 审计持久化（R3）：传入则判定结果自动落库 */
  auditStore?: AuditStore;
  now?: string;
}): Promise<ExecuteActionsResult> {
  const { decisions, auditEntries } = evaluateActions({
    repo: args.repo,
    issueNumber: args.issueNumber,
    traceId: args.traceId,
    actions: args.actions,
    history: args.history,
    now: args.now,
  });

  const executed: ExecuteActionsResult["executed"] = [];
  for (const d of decisions) {
    if (!d.allowed) {
      executed.push({ action: d.action, ok: false, detail: d.reason });
      continue;
    }
    if (d.action.kind === "addLabels") {
      executed.push({ action: d.action, ...(await args.github.addLabels(args.repo, args.issueNumber, d.action.labels)) });
    } else if (d.action.kind === "comment") {
      executed.push({ action: d.action, ...(await args.github.addComment(args.repo, args.issueNumber, d.action.body)) });
    } else {
      // escalate：转人工动作，无外部写
      executed.push({ action: d.action, ok: true, detail: `escalated：${d.action.reason}` });
    }
  }
  // R3：审计落库（允许与否都留痕）；失败不阻塞执行结果返回
  if (args.auditStore) {
    try {
      await args.auditStore.append(auditEntries);
    } catch (err) {
      executed.push({
        action: { kind: "escalate", reason: "audit 落库失败" },
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { executed, auditEntries };
}
