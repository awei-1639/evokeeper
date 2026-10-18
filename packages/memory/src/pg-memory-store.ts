/**
 * MemoryStore 的 Postgres 实现（W4）—— 接口不变，替换 JsonlMemoryStore
 *
 * 语义对齐 InMemoryMemoryStore：
 *  - listByRepo 返回该 repo 全部条目（含已软删；validUntil 过滤由 MemoryLayer.query 负责）；
 *  - softDelete 记忆不存在时抛错（fail loud）；
 *  - save = UPSERT（MemoryLayer.update 的修订路径走 save）。
 *
 * 存储布局：repo/kind/version/valid_until 为查询列 + payload JSONB 存完整 MemoryItem。
 * W4 聚类换 embedding 时：ALTER TABLE 加 vector 列，listByRepo 可换向量预筛（接口注释已预留）。
 */
import { Pool } from "pg";
import type { MemoryItem, MemoryStore } from "./index";

export interface PgMemoryStoreOptions {
  connectionString?: string;
  pool?: Pool;
  max?: number;
}

/** memory 包独立池（不与 agent 侧共享全局，包边界清晰、测试互不干扰） */
export class PgMemoryStore implements MemoryStore {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;

  constructor(options: PgMemoryStoreOptions = {}) {
    const connectionString =
      options.connectionString ?? process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        "缺少 DATABASE_URL 环境变量（本地默认 postgresql://evokeeper:evokeeper_dev_only@localhost:5432/evokeeper，见 infra/docker-compose.yml）"
      );
    }
    this.ownsPool = !options.pool;
    this.pool =
      options.pool ??
      new Pool({
        connectionString,
        max: options.max ?? 3,
        idleTimeoutMillis: 30_000,
        // 业务表隔离在 evokeeper schema（Langfuse 自托管占用 public schema 的同名表）
        options: "-c search_path=evokeeper",
      });
  }

  async get(id: string): Promise<MemoryItem | null> {
    const res = await this.pool.query<{ payload: MemoryItem }>(
      `SELECT payload FROM memory_items WHERE id = $1`,
      [id]
    );
    return res.rows[0]?.payload ?? null;
  }

  async listByRepo(repo: string): Promise<MemoryItem[]> {
    const res = await this.pool.query<{ payload: MemoryItem }>(
      `SELECT payload FROM memory_items WHERE repo = $1 ORDER BY (payload->>'createdAt') ASC`,
      [repo]
    );
    return res.rows.map((r) => r.payload);
  }

  async save(item: MemoryItem): Promise<void> {
    await this.pool.query(
      `INSERT INTO memory_items (id, repo, kind, version, valid_until, payload)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET
         repo = EXCLUDED.repo,
         kind = EXCLUDED.kind,
         version = EXCLUDED.version,
         valid_until = EXCLUDED.valid_until,
         payload = EXCLUDED.payload,
         updated_at = now()`,
      [
        item.id,
        item.repo,
        item.kind,
        item.version,
        item.validUntil,
        JSON.stringify(item),
      ]
    );
  }

  async softDelete(id: string, validUntil: string): Promise<void> {
    const res = await this.pool.query(
      `UPDATE memory_items
       SET valid_until = $2::timestamptz,
           payload = jsonb_set(payload, '{validUntil}', to_jsonb($3::text)),
           updated_at = now()
       WHERE id = $1`,
      [id, validUntil, validUntil]
    );
    if ((res.rowCount ?? 0) === 0) {
      throw new Error(`记忆不存在：${id}`);
    }
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}
