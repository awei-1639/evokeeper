/**
 * TraceStore 的 Postgres 实现（W4）—— 接口不变，替换 JsonlTraceStore
 *
 * 语义对齐 InMemoryTraceStore：
 *  - append 同 id 抛错（fail loud：同 delivery 重放不应重复落库）；
 *  - listByIssue/all 按 started_at 升序（与内存版插入序一致，整理管线输入稳定）。
 *
 * 存储布局：查询列展开（repo/issue_number/started_at）+ payload JSONB 存完整 Trace。
 */
import type { Pool } from "pg";
import type { Trace } from "@evokeeper/core";
import type { TraceStore } from "../trace-store";
import { getSharedPgPool } from "./pool";

export class PgTraceStore implements TraceStore {
  private readonly pool: Pool;

  constructor(options: { pool?: Pool; connectionString?: string } = {}) {
    this.pool = options.pool ?? getSharedPgPool({ connectionString: options.connectionString });
  }

  async append(trace: Trace): Promise<void> {
    const res = await this.pool.query(
      `INSERT INTO traces (id, repo, issue_number, agent_version, started_at, finished_at, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING`,
      [
        trace.id,
        trace.repo,
        trace.issueNumber,
        trace.agentVersion,
        trace.startedAt,
        trace.finishedAt,
        JSON.stringify(trace),
      ]
    );
    if (res.rowCount === 0) {
      throw new Error(`轨迹 id 重复：${trace.id}（同 delivery 重放不应重复落库）`);
    }
  }

  async get(id: string): Promise<Trace | null> {
    const res = await this.pool.query<{ payload: Trace }>(
      `SELECT payload FROM traces WHERE id = $1`,
      [id]
    );
    return res.rows[0]?.payload ?? null;
  }

  async listByIssue(repo: string, issueNumber: number): Promise<Trace[]> {
    const res = await this.pool.query<{ payload: Trace }>(
      `SELECT payload FROM traces WHERE repo = $1 AND issue_number = $2 ORDER BY started_at ASC`,
      [repo, issueNumber]
    );
    return res.rows.map((r) => r.payload);
  }

  async all(): Promise<Trace[]> {
    const res = await this.pool.query<{ payload: Trace }>(
      `SELECT payload FROM traces ORDER BY started_at ASC`
    );
    return res.rows.map((r) => r.payload);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
