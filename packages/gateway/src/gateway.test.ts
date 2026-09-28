/**
 * 工具治理网关测试
 *
 * 锁死 §3.3 / §9 契约：
 * 幂等键 = (repo, issueNumber, actionKind, contentHash)；
 * webhook 重放（同幂等键）不重复执行；
 * 单次配额（≤2 标签 + ≤1 评论）与 24h 评论冷却；
 * 允许与否都产出审计。
 */
import { describe, expect, it } from "vitest";
import type { AgentAction, ToolAuditEntry } from "./index";
import { actionIdempotencyKey, evaluateActions } from "./index";

const NOW = "2026-09-28T12:00:00.000Z";
const LABELS: AgentAction = { kind: "addLabels", labels: ["bug"] };
const COMMENT: AgentAction = { kind: "comment", body: "请补充版本号与复现步骤", quoteRefs: [] };

function auditEntry(partial: Partial<ToolAuditEntry>): ToolAuditEntry {
  return {
    traceId: "trace-old",
    tool: "comment",
    permission: "write-comment",
    argsSummary: "args",
    resultSummary: "accepted",
    idempotencyKey: "key",
    allowed: true,
    at: NOW,
    ...partial,
  };
}

describe("actionIdempotencyKey", () => {
  it("键格式 = repo#issue:kind:contentHash；同内容同键、不同内容不同键", () => {
    const k1 = actionIdempotencyKey("alibaba/nacos", 42, COMMENT);
    const k2 = actionIdempotencyKey("alibaba/nacos", 42, COMMENT);
    const k3 = actionIdempotencyKey("alibaba/nacos", 42, { ...COMMENT, body: "不同内容" });
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^alibaba\/nacos#42:comment:[0-9a-f]{16}$/);
    expect(k3).not.toBe(k1);
  });

  it("标签集合排序后参与哈希：顺序不同、内容相同 → 同键", () => {
    const a = actionIdempotencyKey("alibaba/nacos", 1, { kind: "addLabels", labels: ["bug", "invalid"] });
    const b = actionIdempotencyKey("alibaba/nacos", 1, { kind: "addLabels", labels: ["invalid", "bug"] });
    expect(a).toBe(b);
  });
});

describe("evaluateActions", () => {
  it("正常首次写入：全部放行并产出审计", () => {
    const { decisions, auditEntries } = evaluateActions({
      repo: "alibaba/nacos",
      issueNumber: 42,
      traceId: "trace-1",
      actions: [LABELS, COMMENT],
      history: [],
      now: NOW,
    });
    expect(decisions.map((d) => d.allowed)).toEqual([true, true]);
    expect(auditEntries).toHaveLength(2);
    expect(auditEntries[0]?.permission).toBe("write-label");
    expect(auditEntries[1]?.permission).toBe("write-comment");
  });

  it("webhook 重放（历史中同幂等键已允许）→ 拒绝", () => {
    const first = evaluateActions({
      repo: "alibaba/nacos",
      issueNumber: 42,
      traceId: "trace-1",
      actions: [COMMENT],
      history: [],
      now: NOW,
    });
    const replay = evaluateActions({
      repo: "alibaba/nacos",
      issueNumber: 42,
      traceId: "trace-1",
      actions: [COMMENT],
      history: first.auditEntries,
      now: NOW,
    });
    expect(replay.decisions[0]?.allowed).toBe(false);
    expect(replay.decisions[0]?.reason).toContain("replay");
  });

  it("同批次内重复动作同样拦截", () => {
    const { decisions } = evaluateActions({
      repo: "alibaba/nacos",
      issueNumber: 42,
      traceId: "trace-1",
      actions: [COMMENT, COMMENT],
      history: [],
      now: NOW,
    });
    expect(decisions[0]?.allowed).toBe(true);
    expect(decisions[1]?.allowed).toBe(false);
    expect(decisions[1]?.reason).toContain("replay");
  });

  it("24h 评论冷却：23h 前评论过 → 拦截；25h 前 → 放行", () => {
    // 旧评论内容不同（同内容会先命中 replay，见跨轨迹重放测试）
    const oldAudit = auditEntry({
      idempotencyKey: actionIdempotencyKey("alibaba/nacos", 42, { ...COMMENT, body: "上次请补充的信息还没看到" }),
      at: "2026-09-27T13:00:00.000Z", // 23h 前
    });
    const blocked = evaluateActions({
      repo: "alibaba/nacos",
      issueNumber: 42,
      traceId: "trace-1",
      actions: [COMMENT],
      history: [oldAudit],
      now: NOW,
    });
    expect(blocked.decisions[0]?.allowed).toBe(false);
    expect(blocked.decisions[0]?.reason).toContain("cooldown");

    const oldEnough = auditEntry({
      ...oldAudit,
      idempotencyKey: actionIdempotencyKey("alibaba/nacos", 42, { ...COMMENT, body: "旧的另一条评论" }),
      at: "2026-09-27T11:00:00.000Z", // 25h 前
    });
    const allowed = evaluateActions({
      repo: "alibaba/nacos",
      issueNumber: 42,
      traceId: "trace-1",
      actions: [COMMENT],
      history: [oldEnough],
      now: NOW,
    });
    expect(allowed.decisions[0]?.allowed).toBe(true);
  });

  it("单次配额：两个 addLabels 动作第二个被拦；单动作超 2 标签被拦", () => {
    const capped = evaluateActions({
      repo: "alibaba/nacos",
      issueNumber: 42,
      traceId: "trace-1",
      actions: [
        { kind: "addLabels", labels: ["bug"] },
        { kind: "addLabels", labels: ["question"] },
      ],
      history: [],
      now: NOW,
    });
    expect(capped.decisions[1]?.allowed).toBe(false);
    expect(capped.decisions[1]?.reason).toContain("quota");

    const tooMany = evaluateActions({
      repo: "alibaba/nacos",
      issueNumber: 42,
      traceId: "trace-1",
      actions: [{ kind: "addLabels", labels: ["bug", "question", "invalid"] }],
      history: [],
      now: NOW,
    });
    expect(tooMany.decisions[0]?.allowed).toBe(false);
    expect(tooMany.decisions[0]?.reason).toContain("最多 2 个标签");
  });

  it("escalate 是转人工动作，同样产出审计但走 write 语义之外", () => {
    const { decisions } = evaluateActions({
      repo: "alibaba/nacos",
      issueNumber: 42,
      traceId: "trace-1",
      actions: [{ kind: "escalate", reason: "置信度 0.3 低于阈值" }],
      history: [],
      now: NOW,
    });
    expect(decisions[0]?.allowed).toBe(true);
  });
});

describe("跨轨迹重放防护（content-only 幂等键）", () => {
  it("不同轨迹、相同内容的评论 → 第二次仍被拦截", () => {
    const first = evaluateActions({
      repo: "alibaba/nacos",
      issueNumber: 42,
      traceId: "trace-A",
      actions: [COMMENT],
      history: [],
      now: NOW,
    });
    // 重放场景：GitHub 重新投递 / 新轨迹生成同样内容
    const second = evaluateActions({
      repo: "alibaba/nacos",
      issueNumber: 42,
      traceId: "trace-B-完全不同的轨迹",
      actions: [COMMENT],
      history: first.auditEntries,
      now: NOW,
    });
    expect(second.decisions[0]?.allowed).toBe(false);
    expect(second.decisions[0]?.reason).toContain("replay");
  });
});
