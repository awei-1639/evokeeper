/**
 * Postgres 连接池（W4 适配器共用底座）—— design.md §9
 *
 * 约定：
 *  - DATABASE_URL 必须来自环境变量，禁止硬编码（design.md §9 工程规范）；
 *  - 本仓库只有一个 Postgres 实例，agent 侧各适配器共享一个池（惰性单例）；
 *  - 测试/脚本需要隔离时可用 createPgPool({ connectionString }) 自建。
 */
import { Pool } from "pg";

export interface PgPoolOptions {
  connectionString?: string;
  /** 池上限；适配器场景连接数需求很小 */
  max?: number;
}

export function resolveDatabaseUrl(explicit?: string): string {
  const url = explicit ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "缺少 DATABASE_URL 环境变量（本地默认 postgresql://evokeeper:evokeeper_dev_only@localhost:5432/evokeeper，见 infra/docker-compose.yml）"
    );
  }
  return url;
}

const globalForPg = globalThis as unknown as { __evokeeperPgPool?: Pool };

/** 进程级共享池：多次调用返回同一实例（Node ESM 全局单例，防热重载泄漏连接） */
export function getSharedPgPool(options: PgPoolOptions = {}): Pool {
  if (!globalForPg.__evokeeperPgPool) {
    globalForPg.__evokeeperPgPool = createPgPool(options);
  }
  return globalForPg.__evokeeperPgPool;
}

export function createPgPool(options: PgPoolOptions = {}): Pool {
  return new Pool({
    connectionString: resolveDatabaseUrl(options.connectionString),
    max: options.max ?? 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // 业务表隔离在 evokeeper schema（Langfuse 自托管占用 public schema 的 traces 等同名表）
    options: "-c search_path=evokeeper",
  });
}
