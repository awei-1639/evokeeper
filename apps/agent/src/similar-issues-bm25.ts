/**
 * BM25 轻量相似检索（W6）—— 成本纪律下的 duplicate 证据形态
 *
 * 背景：pgvector 证据注入（5×400 字正文）实测成本 +145%，超 +10% 上限被门禁否决
 * （run-gate-retr-cand，668507d）。膨胀主导来自提示词而非 embed API——flash 模型
 * 单价过低使百分比预算对 prompt 增量极其敏感。
 *
 * 本模块的取舍：BM25（零 API 成本、零 pg 依赖、确定性）+ 只注入编号+标题
 * （top-3 ≈ 100 token，预算内）。dup 判定只需要"存在可引用的原 issue 编号"，
 * 编号+标题即可支撑；正文细节缺失由分诊模型自身知识补足。
 */
import { resolve } from "node:path";
import type { SimilarIssuesSearch } from "./similar-issues";
import type { IssueEvent } from "./index";
import { BM25Index, loadCorpusFromJsonl } from "./retrieval";

/** 检索查询构造时 body 参与长度上限（与向量版 SIMILAR_QUERY_BODY_CHARS 对齐） */
export const BM25_QUERY_BODY_CHARS = 1500;

export function createBm25SimilarIssuesSearch(options: {
  corpusPath: string;
  topK?: number;
  /** 语料缺省即项目主语料（历史 issue + 维护者回复摘要） */
}): SimilarIssuesSearch {
  const corpus = loadCorpusFromJsonl(resolve(process.cwd(), options.corpusPath));
  const index = new BM25Index(corpus);
  const topK = options.topK ?? 3;
  return {
    model: `bm25-lite(top${topK})`,
    async search(event: IssueEvent) {
      const query = `${event.title}\n${event.body.slice(0, BM25_QUERY_BODY_CHARS)}`;
      const hits = index.search(query, topK + 1);
      // 排除 case 自身（与向量版同纪律：否则 duplicate 评测 = 泄漏 gold 原号）
      return hits
        .filter((h) => h.doc.issueNumber !== event.issueNumber)
        .slice(0, topK)
        .map((h) => ({
          issueNumber: h.doc.issueNumber,
          title: h.doc.title,
          snippet: "", // 轻量证据：正文不注入（成本纪律，见文件头）
          score: h.score,
        }));
    },
  };
}
