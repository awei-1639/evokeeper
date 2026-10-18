/**
 * InboxStore 的 Postgres 实现（W4）—— design.md §9：eventId 唯一键去重
 *
 * claim 语义 = INSERT ... ON CONFLICT DO NOTHING：
 *  - 返回 true  = 首次见到该事件（调用方继续处理）；
 *  - 返回 false = 重复投递（webhook 重试/重放），直接吞掉。
 *
 * 与 MemoryInboxStore 的容量淘汰不同：PG 版全量保留，天然满足
 * "事件落库"要求（design.md §2：Inbox 事件落库 + 幂等去重）。
 */
import type { Pool } from "pg";
import type { InboxStore } from "../inbox";
import { getSharedPgPool } from "./pool";

export class PgInboxStore implements InboxStore {
  private readonly pool: Pool;

  constructor(options: { pool?: Pool; connectionString?: string } = {}) {
    this.pool = options.pool ?? getSharedPgPool({ connectionString: options.connectionString });
  }

  async claim(eventId: string): Promise<boolean> {
    const res = await this.pool.query(
      `INSERT INTO inbox_events (event_id) VALUES ($1) ON CONFLICT (event_id) DO NOTHING`,
      [eventId]
    );
    return (res.rowCount ?? 0) > 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
