/**
 * 社区语料检索（W2）—— answer 链路的证据来源
 *
 * W2 用零依赖 BM25（CJK bigram + ASCII 词）；embed 档（text-embedding-v4 + pgvector）
 * 等 infra 就绪后 W4 接入，本模块的 EvidenceDoc 输出形状不变，只换内部实现。
 *
 * 语料 = 社区已积累的知识（历史 issue 正文 + 维护者回复摘要）。真实运行时用户拿着
 * "社区已解决过的问题"来提问，检索命中已有 issue 是符合预期的，不算泄漏。
 */
import fs from "node:fs";

export interface CorpusDoc {
  issueNumber: number;
  title: string;
  body: string;
  /** 维护者/社区回复摘要（语料的价值核心） */
  replies: Array<{ author: string; body: string }>;
}

/**
 * 分词：ASCII 词（保留版本号 2.5.1 / 报错类 token）+ CJK bigram。
 * 不引第三方分词器——零依赖是本仓库的工程约定。
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();
  const ascii = lower.match(/[a-z0-9_+#.\-]{2,}/g) ?? [];
  for (const tok of ascii) {
    tokens.push(tok);
    // 配置项/路径类 token（nacos.remote.client.grpc.maxinbound...）补充分段，
    // 让 "maxinbound.message.size" 这类子串查询也能命中
    if (tok.includes(".")) {
      for (const seg of tok.split(".")) {
        if (seg.length >= 2) tokens.push(seg);
      }
    }
  }
  const cjkRuns = lower.match(/[\u4e00-\u9fff]+/g) ?? [];
  for (const run of cjkRuns) {
    for (let i = 0; i < run.length - 1; i++) {
      tokens.push(run.slice(i, i + 2));
    }
  }
  return tokens;
}

export class BM25Index {
  private readonly docs: Array<{ doc: CorpusDoc; tf: Map<string, number>; len: number }> = [];
  private readonly df = new Map<string, number>();
  private readonly avgLen: number;
  private static readonly K1 = 1.5;
  private static readonly B = 0.75;

  constructor(corpus: readonly CorpusDoc[]) {
    let totalLen = 0;
    for (const doc of corpus) {
      const tokens = tokenize(`${doc.title} ${doc.body} ${doc.replies.map((r) => r.body).join(" ")}`);
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.docs.push({ doc, tf, len: tokens.length });
      totalLen += tokens.length;
    }
    this.avgLen = this.docs.length > 0 ? totalLen / this.docs.length : 0;
  }

  get size(): number {
    return this.docs.length;
  }

  /** 返回按 BM25 分数降序的 top-k 命中 */
  search(query: string, k = 5): Array<{ doc: CorpusDoc; score: number }> {
    if (this.docs.length === 0 || this.avgLen === 0) return [];
    const qTokens = [...new Set(tokenize(query))];
    const scored = this.docs.map(({ doc, tf, len }) => {
      let score = 0;
      for (const t of qTokens) {
        const f = tf.get(t);
        if (!f) continue;
        const n = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (this.docs.length - n + 0.5) / (n + 0.5));
        score +=
          idf *
          ((f * (BM25Index.K1 + 1)) /
            (f + BM25Index.K1 * (1 - BM25Index.B + (BM25Index.B * len) / this.avgLen)));
      }
      return { doc, score };
    });
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
}

/**
 * 从草稿池 JSONL 构建语料。跳过无 issue_number / 重复 / 抓取失败的回复占位。
 */
export function loadCorpusFromJsonl(jsonlPath: string): CorpusDoc[] {
  const lines = fs.readFileSync(jsonlPath, "utf8").trim().split("\n");
  const seen = new Set<number>();
  const docs: CorpusDoc[] = [];
  for (const line of lines) {
    const r = JSON.parse(line) as Record<string, unknown>;
    const num = Number(r["issue_number"]);
    if (!Number.isInteger(num) || seen.has(num)) continue;
    seen.add(num);
    const replies = (Array.isArray(r["maintainer_replies"]) ? r["maintainer_replies"] : [])
      .map((x) => x as { author?: string; body_excerpt?: string })
      .filter((x) => x.author !== "fetch-error" && typeof x.body_excerpt === "string")
      .map((x) => ({ author: x.author ?? "unknown", body: x.body_excerpt as string }));
    docs.push({
      issueNumber: num,
      title: typeof r["title"] === "string" ? (r["title"] as string) : "",
      body: typeof r["body_excerpt"] === "string" ? (r["body_excerpt"] as string) : "",
      replies,
    });
  }
  return docs;
}

/** 单条证据的最大字符数（控 answer 输入成本：5 条 × ~700 字符 ≈ 3.5K 字符） */
export const EVIDENCE_SNIPPET_MAX_CHARS = 300;
export const EVIDENCE_REPLY_MAX_CHARS = 260;

/** 检索命中 → 证据块（喂给 answer 提示词的数据形态） */
export function buildEvidence(
  matches: Array<{ doc: CorpusDoc; score: number }>
): Array<{ issueNumber: number; title: string; snippet: string }> {
  return matches.map(({ doc }) => {
    const parts: string[] = [];
    if (doc.body.trim()) {
      parts.push(doc.body.slice(0, EVIDENCE_SNIPPET_MAX_CHARS));
    }
    for (const r of doc.replies.slice(0, 2)) {
      parts.push(`${r.author}: ${r.body.slice(0, EVIDENCE_REPLY_MAX_CHARS)}`);
    }
    return {
      issueNumber: doc.issueNumber,
      title: doc.title,
      snippet: parts.join("\n"),
    };
  });
}
