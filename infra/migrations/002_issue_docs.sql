-- W4 duplicate 缺口修复：历史 issue 向量库（pgvector）
--
-- 语料 = 草稿池/线上历史 issue（title + body 摘录 + 维护者回复摘要），
-- 由 scripts/embed-backfill.mts 批量 embed 后回填（幂等 upsert）。
-- 检索方：apps/agent/src/similar-issues.ts —— 分诊 duplicate 证据注入。
--
-- 纪律（评测有效性）：检索必须排除 case issue 自身（本表主键即排除依据），
-- 否则 duplicate 评测等于把 gold 原号喂给模型（自评测泄漏，R1 失效）。

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS evokeeper.issue_docs (
  repo TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  body_excerpt TEXT NOT NULL,
  replies_excerpt TEXT NOT NULL DEFAULT '',
  -- 维度 1024 = text-embedding-v4（design.md §9.1）；换 embed 模型必须换列并全量重建
  embedding vector(1024) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (repo, issue_number)
);

-- 注意：索引名不能带 schema 前缀（001 的踩坑记录）
CREATE INDEX IF NOT EXISTS issue_docs_embedding_hnsw
  ON evokeeper.issue_docs USING hnsw (embedding vector_cosine_ops);
