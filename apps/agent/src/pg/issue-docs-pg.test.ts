/**
 * PgIssueDocsStore 集成测试：无 DATABASE_URL 时整组 skip（CI 不依赖容器）
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PgIssueDocsStore, type IssueDocRow } from "./issue-docs-pg";

const DB = process.env.DATABASE_URL;
const d = describe.skipIf(!DB);
const REPO = "alibaba/nacos";

function doc(issueNumber: number, title: string, dim = 1024): IssueDocRow {
  return {
    repo: REPO,
    issueNumber,
    title,
    bodyExcerpt: `body of ${title}`,
    repliesExcerpt: "",
    // 维度合法的伪向量：用确定的方向让两两夹角可控
    embedding: Array.from({ length: dim }, (_, i) => (i === issueNumber % dim ? 1 : 0.01)),
  };
}

d("PgIssueDocsStore", () => {
  let pool: Pool;
  let store: PgIssueDocsStore;

  beforeAll(() => {
    pool = new Pool({
      connectionString: DB,
      options: "-c search_path=evokeeper,public",
      max: 2,
    });
    store = new PgIssueDocsStore(pool);
  });

  afterAll(async () => {
    // 清理本测试写入的数据（表是共享的，不能 TRUNCATE）
    await pool.query("DELETE FROM evokeeper.issue_docs WHERE repo = $1 AND issue_number >= 900000", [REPO]);
    await pool.end();
  });

  it("upsertBatch：写入 + 同主键覆盖", async () => {
    await store.upsertBatch([doc(900001, "重复 bug A"), doc(900002, "重复 bug B")]);
    await store.upsertBatch([doc(900001, "重复 bug A 修改版")]);
    const count = await store.count(REPO);
    expect(count).toBeGreaterThanOrEqual(2);
    const r = await pool.query("SELECT title FROM evokeeper.issue_docs WHERE repo=$1 AND issue_number=900001", [REPO]);
    expect(r.rows[0]?.title).toBe("重复 bug A 修改版");
  });

  it("upsertBatch：维度不符抛错", async () => {
    const bad = { ...doc(900003, "bad"), embedding: [1, 2, 3] };
    await expect(store.upsertBatch([bad])).rejects.toThrow("维度不符");
  });

  it("searchSimilar：命中 Top-K 并排除指定 issue", async () => {
    const hits = await store.searchSimilar({
      repo: REPO,
      queryEmbedding: doc(900001, "").embedding, // 与 900001 方向最接近
      excludeNumbers: [900001],
      k: 2,
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThanOrEqual(2);
    expect(hits.some((h) => h.issueNumber === 900001)).toBe(false);
  });

  it("searchSimilar：查询向量维度不符抛错", async () => {
    await expect(
      store.searchSimilar({ repo: REPO, queryEmbedding: [0.1, 0.2], k: 1 })
    ).rejects.toThrow("维度不符");
  });
});
