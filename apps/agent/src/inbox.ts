/**
 * Inbox —— GitHub webhook 事件接入层（design.md §2 / §9）
 *
 * 职责边界：只做事件接入、幂等去重与重试调度，不含任何业务判断（判断在 ./index 执行器）。
 * GitHub webhook 是至少一次投递：同一 delivery 可能重复到达，消费端必须幂等。
 *
 * 幂等：以 X-GitHub-Delivery 头作为 eventId，InboxStore.claim 原子认领。
 * 当前提供 MemoryInboxStore（容量上限 + 淘汰最旧）；W3 接 Postgres 后换成
 * 唯一键 INSERT ... ON CONFLICT DO NOTHING 的实现即可，接口不变。
 *
 * 重试：design.md §2 队列退避 1m/5m/30m、最多 3 次，之后死信回调（onDeadLetter）。
 * 队列现为进程内 scheduler 注入实现；W3 装 Redis 后换 BullMQ 适配器，重试策略不变。
 *
 * 红线：R2 动作仅限 addLabels / comment / escalate（执行器已保证）；R3 每次处理结果
 * 经 onProcessed 回调产出，W3 轨迹库在此落库。
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { handleIssueEvent, type HandleResult, type IssueEvent } from "./index";

// ---------- 事件映射 ----------

/** 支持消费的 GitHub 事件：design.md §2 列举的 issues.opened / issue_comment.created / reopened 等 */
export const SUPPORTED_EVENT_NAMES = new Set(["issues", "issue_comment"]);

/**
 * 把 GitHub webhook payload 映射为执行器的 IssueEvent。
 * 返回 null 表示该事件无需消费（issues.labeled / issues.closed / 无关 action 等）。
 */
export function parseIssueEvent(eventName: string, payload: unknown): IssueEvent | null {
  if (!SUPPORTED_EVENT_NAMES.has(eventName) || typeof payload !== "object" || payload === null) {
    return null;
  }
  const p = payload as Record<string, unknown>;
  const action = typeof p.action === "string" ? p.action : "";
  const issue = p.issue as Record<string, unknown> | undefined;
  const repo = (p.repository as Record<string, unknown> | undefined)?.full_name;
  if (!issue || typeof repo !== "string") return null;

  const labels = Array.isArray(issue.labels)
    ? issue.labels.map((l) =>
        typeof l === "object" && l !== null && typeof (l as Record<string, unknown>).name === "string"
          ? ((l as Record<string, unknown>).name as string)
          : ""
      ).filter((s) => s.length > 0)
    : [];

  // 分诊消费：opened / reopened 全量分诊；issue_comment.created 带触发评论重分诊。
  // labeled / closed 是维护者的判定动作，不反应（避免与人工打架）。
  if (eventName === "issues" && (action === "opened" || action === "reopened")) {
    return {
      repo,
      issueNumber: Number(issue.number),
      title: typeof issue.title === "string" ? issue.title : "",
      body: typeof issue.body === "string" ? issue.body : "",
      rawLabels: labels,
    };
  }
  if (eventName === "issue_comment" && action === "created") {
    const comment = p.comment as Record<string, unknown> | undefined;
    const author = (comment?.user as Record<string, unknown> | undefined)?.login;
    return {
      repo,
      issueNumber: Number(issue.number),
      title: typeof issue.title === "string" ? issue.title : "",
      body: typeof issue.body === "string" ? issue.body : "",
      comments:
        typeof comment?.body === "string"
          ? [{ author: typeof author === "string" ? author : "unknown", body: comment.body as string }]
          : [],
      rawLabels: labels,
    };
  }
  return null;
}

// ---------- 幂等存储 ----------

export interface InboxStore {
  /** 原子认领：true = 首次收到（已记录），false = 重复投递 */
  claim(eventId: string): Promise<boolean>;
}

/** 进程内实现：容量上限，满了淘汰最旧（W3 换 Postgres 唯一键实现） */
export class MemoryInboxStore implements InboxStore {
  private readonly seen = new Map<string, true>();

  constructor(private readonly maxEntries = 10_000) {}

  async claim(eventId: string): Promise<boolean> {
    if (this.seen.has(eventId)) return false;
    this.seen.set(eventId, true);
    const oldest = this.seen.keys().next().value;
    if (this.seen.size > this.maxEntries && oldest !== undefined) {
      this.seen.delete(oldest);
    }
    return true;
  }

  get size(): number {
    return this.seen.size;
  }
}

// ---------- 重试策略 ----------

/** design.md §2：退避 1m/5m/30m，最多 3 次 */
export const RETRY_DELAYS_MS: readonly number[] = [60_000, 300_000, 1_800_000];

/**
 * 已失败 failedAttempts 次（从 1 计）后的下次重试延迟；返回 null = 重试耗尽，转死信。
 */
export function nextRetryDelayMs(failedAttempts: number): number | null {
  if (failedAttempts < 1) return RETRY_DELAYS_MS[0] ?? null;
  return RETRY_DELAYS_MS[failedAttempts - 1] ?? null;
}

// ---------- 处理器 ----------

export interface WebhookDelivery {
  /** X-GitHub-Delivery 头，幂等键 */
  eventId: string;
  /** X-GitHub-Event 头，如 issues / issue_comment */
  eventName: string;
  payload: unknown;
}

export type IngestStatus = "accepted" | "duplicate" | "ignored";

export interface IngestOutcome {
  status: IngestStatus;
  /** accepted 时返回映射出的事件，供调试；ignored/duplicate 为 null */
  event: IssueEvent | null;
}

export interface InboxDeps {
  store?: InboxStore;
  /** 默认 handleIssueEvent；测试注入 mock */
  handle?: (event: IssueEvent) => Promise<HandleResult>;
  /**
   * 调度器：默认 setTimeout。首次处理延迟 0ms 也走调度器，
   * 使 webhook 接入层能立即响应（design.md：用户面不做业务判断），
   * 测试则可手动驱动任务获得确定性。
   */
  schedule?: (delayMs: number, task: () => Promise<void> | void) => void;
  /** R3 落库钩子：每次处理成功后回调，W3 轨迹库在此接入 */
  onProcessed?: (delivery: WebhookDelivery, result: HandleResult) => void;
  /** 重试耗尽回调（接告警/死信队列） */
  onDeadLetter?: (delivery: WebhookDelivery, error: Error, failedAttempts: number) => void;
}

const defaultSchedule: NonNullable<InboxDeps["schedule"]> = (delayMs, task) => {
  const t = setTimeout(() => void task(), delayMs);
  // 不阻止进程退出（W2 无常驻队列进程时避免挂起）
  t.unref?.();
};

export function createInboxProcessor(deps: InboxDeps = {}) {
  const store = deps.store ?? new MemoryInboxStore();
  const handle = deps.handle ?? handleIssueEvent;
  const schedule = deps.schedule ?? defaultSchedule;
  const pending = new Map<string, { failedAttempts: number; lastError: Error }>();

  async function run(delivery: WebhookDelivery, event: IssueEvent, attempt: number): Promise<void> {
    try {
      const result = await handle(event);
      pending.delete(delivery.eventId);
      deps.onProcessed?.(delivery, result);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const failedAttempts = attempt;
      const delay = nextRetryDelayMs(failedAttempts);
      if (delay === null) {
        pending.delete(delivery.eventId);
        deps.onDeadLetter?.(delivery, error, failedAttempts);
        return;
      }
      pending.set(delivery.eventId, { failedAttempts, lastError: error });
      schedule(delay, () => run(delivery, event, failedAttempts + 1));
    }
  }

  /**
   * 接入一条投递：幂等认领 → 事件映射 → 异步调度处理。
   * 快速返回（不做 LLM 调用），webhook 端可立即响应 GitHub。
   */
  async function ingest(delivery: WebhookDelivery): Promise<IngestOutcome> {
    if (!(await store.claim(delivery.eventId))) {
      return { status: "duplicate", event: null };
    }
    const event = parseIssueEvent(delivery.eventName, delivery.payload);
    if (!event) {
      return { status: "ignored", event: null };
    }
    schedule(0, () => run(delivery, event, 1));
    return { status: "accepted", event };
  }

  return {
    ingest,
    /** 重试中的投递状态（观测用） */
    pending,
  };
}

export type InboxProcessor = ReturnType<typeof createInboxProcessor>;

// ---------- 签名校验 ----------

/** 校验 X-Hub-Signature-256（sha256=<hex>），防伪造投递 */
export function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  signatureHeader: string | undefined
): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const given = signatureHeader.slice("sha256=".length);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(given, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
