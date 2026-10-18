-- EvoKeeper 初始表结构（W4 适配器接线，2026-10-18）
-- 设计依据：docs/design.md §5（轨迹）/§4（记忆）/§9（Inbox 幂等）
-- 执行方式：scripts/db-init.mts（读本文件在 DATABASE_URL 上执行，幂等可重复跑）
--
-- 约定：
--  - 业务表放独立 schema `evokeeper`：Langfuse 自托管与业务共用同一数据库，
--    其 Prisma 迁移在 public schema 建有同名 traces 表——必须隔离；
--    运行时适配器连接串以 options='-c search_path=evokeeper' 指向本 schema；
--  - 行内只放查询需要的展开列 + 完整 JSONB payload（领域对象单事实源，schema 演进不破坏读取）；
--  - pgvector embedding 列待 W4 聚类换 embedding 时再加（ALTER TABLE，见文末注释）；
--  - 所有时间戳 TIMESTAMPTZ，ISO 字符串写入由适配器转换。

CREATE SCHEMA IF NOT EXISTS evokeeper;

CREATE TABLE IF NOT EXISTS evokeeper.traces (
  id           TEXT PRIMARY KEY,              -- trace-<uuid>；同 delivery 重放落库冲突由适配器抛错（fail loud）
  repo         TEXT   NOT NULL,
  issue_number INTEGER NOT NULL,
  agent_version TEXT  NOT NULL,
  started_at   TIMESTAMPTZ NOT NULL,
  finished_at  TIMESTAMPTZ NOT NULL,
  payload      JSONB   NOT NULL               -- 完整 Trace（steps/finalActions/cost/tokens）
);

CREATE INDEX IF NOT EXISTS traces_repo_issue_idx ON evokeeper.traces (repo, issue_number);
CREATE INDEX IF NOT EXISTS traces_started_at_idx ON evokeeper.traces (started_at);

-- Inbox 幂等：claim = INSERT ... ON CONFLICT DO NOTHING（design.md §9 eventId 唯一键）
CREATE TABLE IF NOT EXISTS evokeeper.inbox_events (
  event_id   TEXT PRIMARY KEY,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 记忆层：软删 = payload->validUntil 置值 + 独立列冗余（查询可索引）
CREATE TABLE IF NOT EXISTS evokeeper.memory_items (
  id         TEXT PRIMARY KEY,
  repo       TEXT   NOT NULL,
  kind       TEXT   NOT NULL,                 -- episodic | semantic | procedural | preference
  version    TEXT   NOT NULL,                 -- 经验集版本（exp-v*），未发布为 code 版本
  valid_until TIMESTAMPTZ,                    -- NULL=在位；软删置失效时刻
  payload    JSONB  NOT NULL,                 -- 完整 MemoryItem（content/evidenceRefs/confidence/expectedSlice）
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS memory_items_repo_idx ON evokeeper.memory_items (repo);
CREATE INDEX IF NOT EXISTS memory_items_repo_valid_idx ON evokeeper.memory_items (repo, valid_until);

-- W4 聚类换 embedding 时执行（pgvector 扩展已在容器内）：
--   CREATE EXTENSION IF NOT EXISTS vector;
--   ALTER TABLE memory_items ADD COLUMN embedding vector(1024);
--   CREATE INDEX ON evokeeper.memory_items USING hnsw (embedding vector_cosine_ops);
