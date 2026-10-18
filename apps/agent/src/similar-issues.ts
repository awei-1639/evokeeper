/**
 * 相似 issue 检索（W4）—— 分诊 duplicate 证据注入
 *
 * 链路：query(title+body 摘录) → embed(text-embedding-v4) → pgvector cosine Top-K
 * → SimilarIssue[]（注入 <similar_issues> 块，数据进结构化字段，不拼系统指令）。
 *
 * 纪律：
 * 1. 检索必须排除 case 自身（excludeNumbers），否则 duplicate 评测 = 泄漏 gold 原号；
 * 2. 检索失败降级为空证据（返回 []），绝不阻断分诊主链路——与观测层同一哲学。
 */
import { resolveModel, type Llm } from "@evokeeper/llm";
import type { ModelConfig } from "@evokeeper/core";
import type { IssueEvent } from "./index";
import type { IssueDocsStore, SimilarIssueHit } from "./pg/issue-docs-pg";

/** 注入分诊提示词的相似 issue 数（design.md §4：Top-K=5） */
export const SIMILAR_TOPK = 5;
/** 参与分诊注入的单条相似 issue 正文摘录上限（控成本：5 × ~400 字符） */
export const SIMILAR_SNIPPET_MAX_CHARS = 400;
/** 查询文本构造时 body 参与长度上限 */
export const SIMILAR_QUERY_BODY_CHARS = 1500;

export interface SimilarIssue {
  issueNumber: number;
  title: string;
  snippet: string;
  score: number;
}

export interface SimilarIssuesSearch {
  search(event: IssueEvent): Promise<SimilarIssue[]>;
  /** 检索器元信息（TraceStep 记录用） */
  model: string;
}

export function createSimilarIssuesSearch(options: {
  llm: Llm;
  store: IssueDocsStore;
  config?: ModelConfig;
  topK?: number;
}): SimilarIssuesSearch {
  const model = resolveModel("embed", options.config);
  const topK = options.topK ?? SIMILAR_TOPK;
  return {
    model,
    async search(event: IssueEvent): Promise<SimilarIssue[]> {
      const queryText = `${event.title}\n${event.body.slice(0, SIMILAR_QUERY_BODY_CHARS)}`;
      const embedded = await options.llm.embed([queryText]);
      const queryEmbedding = embedded.vectors[0];
      if (!queryEmbedding) return [];
      const hits: SimilarIssueHit[] = await options.store.searchSimilar({
        repo: event.repo,
        queryEmbedding,
        excludeNumbers: [event.issueNumber],
        k: topK,
      });
      return hits.map((h) => ({
        issueNumber: h.issueNumber,
        title: h.title,
        snippet: `${h.bodyExcerpt.slice(0, SIMILAR_SNIPPET_MAX_CHARS)}${
          h.repliesExcerpt ? `\n维护者回复摘要: ${h.repliesExcerpt.slice(0, 200)}` : ""
        }`,
        score: h.score,
      }));
    },
  };
}
