/**
 * PG 适配器集成测试（TraceStore / InboxStore）
 *
 * 运行条件：DATABASE_URL 指向真实 Postgres（infra 容器）。未配置时整组 skip，
 * 因此 CI（无容器）天然跳过；本地起 infra 后 `DATABASE_URL=... pnpm test` 全跑。
 *
 * 隔离：使用随机 repo 前缀 + 测试结束清理，不动其他数据。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import type { Trace } from "@evokeeper/core";
import { PgTraceStore } from "./trace-store-pg";
import { PgInboxStore } from "./inbox-store-pg";
import { createPgPool } from "./pool";

const DB = process.env.DATABASE_URL;
const d = describe.skipIf(!DB);

function makeTrace(repo: string, issueNumber: number, id?: string): Trace {
  const t = new Date("2026-10-18T10:00:00Z").toISOString();
  return {
    id: id ?? `trace-${randomUUID()}`,
    repo,
    issueNumber,
    agentVersion: "0.1.0",
    issueExcerpt: "测试轨迹摘要",
    steps: [
      {
        seq: 1,
        kind: "llm",
        promptVersion: "tp-1.2",
        model: "deepseek-v4-flash",
        inputTokens: 100,
        outputTokens: 20,
        costAmount: 0.001,
        toolSummary: null,
        startedAt: t,
        durationMs: 500,
      },
    ],
    finalActions: [{ kind: "addLabels", labels: ["bug"] }],
    totalCost: 0.001,
    totalTokens: 120,
    startedAt: t,
    finishedAt: t,
  };
}

d("PgTraceStore", () => {
  let pool: Pool;
  let store: PgTraceStore;
  const repo = `it/pg-trace-${randomUUID()}`;

  beforeAll(() => {
    pool = createPgPool({ connectionString: DB });
    store = new PgTraceStore({ pool });
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM traces WHERE repo = $1`, [repo]);
    await store.close();
  });

  it("append + get 往返（steps/actions/cost 无损）", async () => {
    const trace = makeTrace(repo, 1);
    await store.append(trace);
    const got = await store.get(trace.id);
    expect(got).toEqual(trace);
  });

  it("append 同 id 抛错（fail loud，语义与内存版一致）", async () => {
    const trace = makeTrace(repo, 1);
    await store.append(trace);
    await expect(store.append(trace)).rejects.toThrow(/轨迹 id 重复/);
  });

  it("listByIssue 按 started_at 升序", async () => {
    const t1 = makeTrace(repo, 2);
    const t2 = makeTrace(repo, 2);
    t2.startedAt = "2026-10-18T11:00:00Z";
    await store.append(t2);
    await store.append(t1); // 故意乱序插入
    const list = await store.listByIssue(repo, 2);
    expect(list.map((x) => x.id)).toEqual([t1.id, t2.id]);
  });

  it("get 不存在的 id 返回 null", async () => {
    expect(await store.get("trace-nope")).toBeNull();
  });
});

d("PgInboxStore", () => {
  let pool: Pool;
  let store: PgInboxStore;
  const prefix = `it-inbox-${randomUUID()}`;

  beforeAll(() => {
    pool = createPgPool({ connectionString: DB });
    store = new PgInboxStore({ pool });
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM inbox_events WHERE event_id LIKE $1`, [`${prefix}%`]);
    await store.close();
  });

  it("claim 首次 true、重复 false（幂等语义）", async () => {
    expect(await store.claim(`${prefix}-1`)).toBe(true);
    expect(await store.claim(`${prefix}-1`)).toBe(false);
    expect(await store.claim(`${prefix}-2`)).toBe(true);
  });
});
