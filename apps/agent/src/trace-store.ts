/**
 * 轨迹库（W3）—— design.md §5
 *
 * 落库时机：执行完成后同步落库（成功与失败都落）；Trace 逐步 append，
 * 携带 promptVersion / model / tokens / costAmount（R3：没有轨迹就无法归因与回滚）。
 *
 * W3 提供接口 + 两个实现：InMemoryTraceStore（测试/评审）、JsonlTraceStore
 * （本地落盘，一行一条追加，重启可恢复）。W4 Postgres 就绪后换适配器，接口不变。
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { Trace } from "@evokeeper/core";
import type { HandleResult, IssueEvent } from "./index";

/** 代码版本（经验集版本未发布前无后缀；W6 起形如 "0.1.0+exp-v2"） */
export const AGENT_CODE_VERSION = "0.1.0";

/**
 * HandleResult → Trace 装配。
 * startedAt 取首步，finishedAt 取各步结束时刻的最大值；成本与 token 全量累加（R3）。
 */
export function buildTrace(
  event: IssueEvent,
  result: HandleResult,
  opts: { id?: string; finishedAt?: string } = {}
): Trace {
  const steps = result.steps;
  const startedAt = steps[0]?.startedAt ?? new Date().toISOString();
  let finishedAt = opts.finishedAt ?? startedAt;
  for (const s of steps) {
    const end = Date.parse(s.startedAt) + s.durationMs;
    if (end > Date.parse(finishedAt)) finishedAt = new Date(end).toISOString();
  }
  return {
    id: opts.id ?? `trace-${randomUUID()}`,
    repo: event.repo,
    issueNumber: event.issueNumber,
    agentVersion: AGENT_CODE_VERSION,
    steps,
    finalActions: result.actions,
    totalCost: steps.reduce((a, s) => a + s.costAmount, 0),
    totalTokens: steps.reduce((a, s) => a + s.inputTokens + s.outputTokens, 0),
    startedAt,
    finishedAt,
  };
}

export interface TraceStore {
  append(trace: Trace): Promise<void>;
  get(id: string): Promise<Trace | null>;
  listByIssue(repo: string, issueNumber: number): Promise<Trace[]>;
  /** 全量扫描（W5 整理管线的输入；PG 版由查询替代） */
  all(): Promise<Trace[]>;
}

export class InMemoryTraceStore implements TraceStore {
  private readonly traces = new Map<string, Trace>();

  async append(trace: Trace): Promise<void> {
    if (this.traces.has(trace.id)) {
      throw new Error(`轨迹 id 重复：${trace.id}（同 delivery 重放不应重复落库）`);
    }
    this.traces.set(trace.id, trace);
  }

  async get(id: string): Promise<Trace | null> {
    return this.traces.get(id) ?? null;
  }

  async listByIssue(repo: string, issueNumber: number): Promise<Trace[]> {
    return [...this.traces.values()].filter(
      (t) => t.repo === repo && t.issueNumber === issueNumber
    );
  }

  async all(): Promise<Trace[]> {
    return [...this.traces.values()];
  }

  get size(): number {
    return this.traces.size;
  }
}

/** 本地 JSONL 落盘：一行一条 Trace，启动时加载，append 同步刷盘 */
export class JsonlTraceStore implements TraceStore {
  private readonly traces = new Map<string, Trace>();

  constructor(private readonly filePath: string) {
    if (existsSync(filePath)) {
      for (const line of readFileSync(filePath, "utf8").trim().split("\n")) {
        if (!line) continue;
        const t = JSON.parse(line) as Trace;
        this.traces.set(t.id, t);
      }
    }
  }

  async append(trace: Trace): Promise<void> {
    if (this.traces.has(trace.id)) {
      throw new Error(`轨迹 id 重复：${trace.id}（同 delivery 重放不应重复落库）`);
    }
    this.traces.set(trace.id, trace);
    appendFileSync(this.filePath, JSON.stringify(trace) + "\n", "utf8");
  }

  async get(id: string): Promise<Trace | null> {
    return this.traces.get(id) ?? null;
  }

  async listByIssue(repo: string, issueNumber: number): Promise<Trace[]> {
    return [...this.traces.values()].filter(
      (t) => t.repo === repo && t.issueNumber === issueNumber
    );
  }

  async all(): Promise<Trace[]> {
    return [...this.traces.values()];
  }
}
