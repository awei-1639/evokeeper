/**
 * PgMemoryStore 集成测试（无 DATABASE_URL 时整组 skip，CI 天然跳过）
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import type { MemoryItem } from "./index";
import { PgMemoryStore } from "./pg-memory-store";
import { Pool as PgPool } from "pg";

const DB = process.env.DATABASE_URL;
const d = describe.skipIf(!DB);

function makeItem(repo: string, id?: string, validUntil: string | null = null): MemoryItem {
  return {
    id: id ?? `mem-${randomUUID()}`,
    repo,
    kind: "semantic",
    content: "测试记忆：nacos 客户端心跳间隔默认 5s",
    evidenceRefs: ["trace-it-1"],
    confidence: 0.8,
    validUntil,
    expectedSlice: "labels=bug & topic=client",
    version: "code-0.1.0",
    createdAt: "2026-10-18T10:00:00Z",
  };
}

d("PgMemoryStore", () => {
  let pool: Pool;
  let store: PgMemoryStore;
  const repo = `it/pg-mem-${randomUUID()}`;

  beforeAll(() => {
    pool = new PgPool({ connectionString: DB, options: "-c search_path=evokeeper" });
    store = new PgMemoryStore({ pool });
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM memory_items WHERE repo = $1`, [repo]);
    await store.close();
    await pool.end();
  });

  it("save + get + listByRepo 往返", async () => {
    const item = makeItem(repo);
    await store.save(item);
    expect(await store.get(item.id)).toEqual(item);
    const list = await store.listByRepo(repo);
    expect(list.map((x) => x.id)).toContain(item.id);
  });

  it("save 同 id 为 UPSERT（修订路径）", async () => {
    const item = makeItem(repo);
    await store.save(item);
    const revised = { ...item, content: "修订后的内容", confidence: 0.9 };
    await store.save(revised);
    const got = await store.get(item.id);
    expect(got?.content).toBe("修订后的内容");
    expect(got?.confidence).toBe(0.9);
  });

  it("softDelete 置 validUntil 且 get 读回软删态（过滤归 MemoryLayer）", async () => {
    const item = makeItem(repo);
    await store.save(item);
    await store.softDelete(item.id, "2026-10-19T00:00:00Z");
    const got = await store.get(item.id);
    expect(got?.validUntil).toBe("2026-10-19T00:00:00Z");
    // listByRepo 仍返回（含软删，MemoryLayer 负责失效过滤）
    expect((await store.listByRepo(repo)).map((x) => x.id)).toContain(item.id);
  });

  it("softDelete 不存在的 id 抛错", async () => {
    await expect(store.softDelete("mem-nope", "2026-10-19T00:00:00Z")).rejects.toThrow(
      /记忆不存在/
    );
  });
});
