/**
 * 历史 issue 向量库（pgvector）—— W4 duplicate 证据的存储与检索
 *
 * 表：evokeeper.issue_docs（infra/migrations/002_issue_docs.sql），1024 维 cosine + HNSW。
 * 写入：scripts/embed-backfill.mts 批量 upsert；读取：similar-issues.ts 检索注入。
 *
 * 评测有效性纪律：searchSimilar 必须传 excludeNumbers（至少排除 case 自身），
 * 否则 duplicate 评测等于泄漏 gold 原号（R1 失效）。
 */
import type { Pool } from "pg";

export interface IssueDocRow {
  repo: string;
  issueNumber: number;
  title: string;
  bodyExcerpt: string;
  repliesExcerpt: string;
  embedding: number[];
}

export interface SimilarIssueHit {
  issueNumber: number;
  title: string;
  bodyExcerpt: string;
  repliesExcerpt: string;
  /** cosine 相似度（1 - 距离），0~1 */
  score: number;
}

export interface IssueDocsStore {
  upsertBatch(docs: readonly IssueDocRow[]): Promise<void>;
  searchSimilar(options: {
    repo: string;
    queryEmbedding: number[];
    /** 排除的 issue 号（评测 = [case 自身]；线上 = [当前 issue]） */
    excludeNumbers?: readonly number[];
    k?: number;
  }): Promise<SimilarIssueHit[]>;
  count(repo?: string): Promise<number>;
}

const EMBEDDING_DIM = 1024;

export class PgIssueDocsStore implements IssueDocsStore {
  constructor(
    private readonly pool: Pool,
    private readonly log: (msg: string) => void = () => {}
  ) {}

  async upsertBatch(docs: readonly IssueDocRow[]): Promise<void> {
    if (docs.length === 0) return;
    for (const doc of docs) {
      if (doc.embedding.length !== EMBEDDING_DIM) {
        throw new Error(
          `embedding 维度不符：#${doc.issueNumber} 得到 ${doc.embedding.length}，期望 ${EMBEDDING_DIM}`
        );
      }
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // pgvector 字面量格式：'[1,2,3]'（vector 输入不走 search_path 敏感的 cast 路径）
      for (const doc of docs) {
        await client.query(
          `INSERT INTO evokeeper.issue_docs
             (repo, issue_number, title, body_excerpt, replies_excerpt, embedding)
           VALUES ($1, $2, $3, $4, $5, $6::vector)
           ON CONFLICT (repo, issue_number) DO UPDATE SET
             title = EXCLUDED.title,
             body_excerpt = EXCLUDED.body_excerpt,
             replies_excerpt = EXCLUDED.replies_excerpt,
             embedding = EXCLUDED.embedding`,
          [
            doc.repo,
            doc.issueNumber,
            doc.title,
            doc.bodyExcerpt,
            doc.repliesExcerpt,
            `[${doc.embedding.join(",")}]`,
          ]
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async searchSimilar(options: {
    repo: string;
    queryEmbedding: number[];
    excludeNumbers?: readonly number[];
    k?: number;
  }): Promise<SimilarIssueHit[]> {
    const { repo, queryEmbedding, excludeNumbers = [], k = 5 } = options;
    if (queryEmbedding.length !== EMBEDDING_DIM) {
      throw new Error(
        `查询向量维度不符：${queryEmbedding.length}，期望 ${EMBEDDING_DIM}`
      );
    }
    const result = await this.pool.query<{
      issue_number: number;
      title: string;
      body_excerpt: string;
      replies_excerpt: string;
      score: string | number;
    }>(
      `SELECT issue_number, title, body_excerpt, replies_excerpt,
              1 - (embedding <=> $2::vector) AS score
       FROM evokeeper.issue_docs
       WHERE repo = $1 AND NOT (issue_number = ANY($3::int[]))
       ORDER BY embedding <=> $2::vector
       LIMIT $4`,
      [repo, `[${queryEmbedding.join(",")}]`, excludeNumbers.length > 0 ? [...excludeNumbers] : [0], k]
    );
    return result.rows.map((r) => ({
      issueNumber: Number(r.issue_number),
      title: r.title,
      bodyExcerpt: r.body_excerpt,
      repliesExcerpt: r.replies_excerpt,
      score: Number(r.score),
    }));
  }

  async count(repo?: string): Promise<number> {
    const result = repo
      ? await this.pool.query<{ n: string }>("SELECT count(*) AS n FROM evokeeper.issue_docs WHERE repo = $1", [repo])
      : await this.pool.query<{ n: string }>("SELECT count(*) AS n FROM evokeeper.issue_docs");
    return Number(result.rows[0]?.n ?? 0);
  }
}
