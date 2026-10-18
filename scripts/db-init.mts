/**
 * 数据库初始化脚本：在 DATABASE_URL 上幂等执行 infra/migrations/*.sql
 *
 * 用法：
 *   DATABASE_URL=postgresql://... node --import tsx scripts/db-init.mts
 *   （或直接 node scripts/db-init.mts，走 tsx loader 由 package.json scripts 提供）
 *
 * 幂等性：全部 DDL 带 IF NOT EXISTS，可重复执行。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "infra", "migrations");

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("缺少 DATABASE_URL（本地默认见 infra/docker-compose.yml）");
    process.exit(1);
  }

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const client = new Client({ connectionString });
  await client.connect();
  try {
    for (const file of files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      await client.query(sql);
      console.log(`✓ ${file}`);
    }
    console.log(`\n迁移完成：${files.length} 个文件`);
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error("迁移失败：", err);
  process.exit(1);
});
