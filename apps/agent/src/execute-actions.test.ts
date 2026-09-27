/**
 * GitHub 写动作执行器测试（mock client + gateway 联动）
 *
 * 锁死：gateway 拦截的动作不触达 GitHub；放行的动作如实执行；
 * escalate 不产生外部写；DryRun 客户端零外部副作用（§7.1 dry-run 要求）。
 */
import { describe, expect, it } from "vitest";
import type { AgentAction } from "@evokeeper/core";
import { DryRunGithubClient, executeActions } from "./github-client";

const LABELS: AgentAction = { kind: "addLabels", labels: ["bug"] };
const COMMENT: AgentAction = { kind: "comment", body: "请补充版本号与复现步骤", quoteRefs: [] };

describe("executeActions", () => {
  it("放行动作依次触达 GitHub（DryRun 记录调用）", async () => {
    const client = new DryRunGithubClient();
    const r = await executeActions({
      repo: "alibaba/nacos",
      issueNumber: 42,
      traceId: "trace-1",
      actions: [LABELS, COMMENT],
      history: [],
      github: client,
      now: "2026-09-28T12:00:00.000Z",
    });
    expect(r.executed).toHaveLength(2);
    expect(r.executed.every((e) => e.ok)).toBe(true);
    expect(client.calls).toHaveLength(2);
    expect(client.calls[0]).toMatchObject({ method: "addLabels", issueNumber: 42 });
    expect(client.calls[1]?.method).toBe("addComment");
    // 审计与判定一致（R3）
    expect(r.auditEntries).toHaveLength(2);
    expect(r.auditEntries.every((a) => a.allowed)).toBe(true);
  });

  it("gateway 冷却拦截的动作不触达 GitHub", async () => {
    const client = new DryRunGithubClient();
    const prior = new DryRunGithubClient();
    const first = await executeActions({
      repo: "alibaba/nacos",
      issueNumber: 42,
      traceId: "trace-0",
      actions: [COMMENT],
      history: [],
      github: prior,
      now: "2026-09-28T11:00:00.000Z",
    });
    const second = await executeActions({
      repo: "alibaba/nacos",
      issueNumber: 42,
      traceId: "trace-1",
      actions: [COMMENT],
      history: first.auditEntries,
      github: client,
      now: "2026-09-28T12:00:00.000Z", // 1h 后 → 冷却期内
    });
    expect(second.executed[0]?.ok).toBe(false);
    expect(second.executed[0]?.detail).toContain("cooldown");
    expect(client.calls).toHaveLength(0); // 关键：被拦动作不触达外部
  });

  it("escalate 不产生外部写", async () => {
    const client = new DryRunGithubClient();
    const r = await executeActions({
      repo: "alibaba/nacos",
      issueNumber: 42,
      traceId: "trace-1",
      actions: [{ kind: "escalate", reason: "置信度低" }],
      history: [],
      github: client,
    });
    expect(r.executed[0]?.ok).toBe(true);
    expect(client.calls).toHaveLength(0);
  });
});
