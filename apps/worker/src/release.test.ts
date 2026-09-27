/**
 * 发布回滚状态机测试（§8）
 *
 * 锁死：R1 门禁未过禁止发布；无 diff 拒绝落库；灰度裁决三态；
 * 回滚 = 切回上一版本完整快照（rollbackOf 指向被回滚版本）。
 */
import { describe, expect, it } from "vitest";
import type { CanaryMetrics, ExperienceCandidate, GateDecision } from "@evokeeper/core";
import { createRelease, createRollback, decideCanary } from "./release";

const GATE_PASS: GateDecision = {
  evalRunId: "run-1",
  passed: true,
  checks: [],
  decidedAt: "2026-09-28T00:00:00.000Z",
};
const GATE_FAIL: GateDecision = { ...GATE_PASS, passed: false };

const CANDIDATE: ExperienceCandidate = {
  id: "cand-1",
  type: "skill",
  repo: "alibaba/nacos",
  pattern: "JDK 与编译插件版本不兼容的构建失败处理",
  content: "1) 核对版本矩阵 2) 升级插件",
  expectedSlice: "labels=bug & topic=build-error",
  evidenceTraceIds: ["trace-1", "trace-2", "trace-3"],
  consolidationJobId: "job-1",
  status: "approved",
  createdAt: "2026-09-28T00:00:00.000Z",
};

const DIFF = { skill: "构建失败先查版本矩阵", prompt: null, memory: null };

describe("createRelease", () => {
  it("R1：门禁未过直接抛错，永不落库", () => {
    expect(() => createRelease({ version: "v2", candidate: CANDIDATE, gateDecision: GATE_FAIL, diff: DIFF })).toThrow(
      "R1 违规"
    );
  });

  it("无 diff（三槽位全空）拒绝落库", () => {
    expect(() =>
      createRelease({ version: "v2", candidate: CANDIDATE, gateDecision: GATE_PASS, diff: { skill: null, prompt: null, memory: null } })
    ).toThrow("无 diff");
  });

  it("候选未过人工评审（proposed）拒绝发布", () => {
    expect(() =>
      createRelease({ version: "v2", candidate: { ...CANDIDATE, status: "proposed" }, gateDecision: GATE_PASS, diff: DIFF })
    ).toThrow("approved");
  });

  it("合法发布 → canary 状态 + 完整快照", () => {
    const r = createRelease({
      version: "v2",
      candidate: CANDIDATE,
      gateDecision: GATE_PASS,
      diff: DIFF,
      canaryScope: "alibaba/nacos",
      now: "2026-09-28T00:00:00.000Z",
    });
    expect(r.status).toBe("canary");
    expect(r.diff).toContain("版本矩阵");
    expect(r.gateDecisionId).toBe("run-1");
    expect(r.rollbackOf).toBeNull();
  });
});

describe("decideCanary（48h 观察裁决）", () => {
  const base: CanaryMetrics = {
    releaseVersion: "v2",
    scope: "alibaba/nacos",
    sampleSize: 100,
    humanCorrectionRate: 0.02,
    escalateRate: 0.1,
    costPerIssue: 0.004,
    p95LatencyMs: 7000,
    negativeReactionCount: 0,
    decision: "pending",
    observedFrom: "2026-09-28T00:00:00.000Z",
    observedTo: "2026-09-30T00:00:00.000Z",
  };

  it("样本不足 → pending（继续观察）", () => {
    expect(decideCanary({ ...base, sampleSize: 10 })).toBe("pending");
  });

  it("无负面信号 → promote", () => {
    expect(decideCanary(base)).toBe("promote");
  });

  it("维护者纠正率 > 5% → rollback（灰度最敏感信号）", () => {
    expect(decideCanary({ ...base, humanCorrectionRate: 0.08 })).toBe("rollback");
  });

  it("escalate 率 > 20% → rollback", () => {
    expect(decideCanary({ ...base, escalateRate: 0.3 })).toBe("rollback");
  });

  it("负面反应 > 0 → rollback", () => {
    expect(decideCanary({ ...base, negativeReactionCount: 1 })).toBe("rollback");
  });
});

describe("createRollback（O(1) 切回快照）", () => {
  const v2 = createRelease({
    version: "v2",
    candidate: CANDIDATE,
    gateDecision: GATE_PASS,
    diff: DIFF,
    now: "2026-09-28T00:00:00.000Z",
  });
  const v1Snapshot = {
    version: "v1",
    candidateId: null,
    diff: JSON.stringify({ skill: "旧版技能（基线无经验）", prompt: null, memory: null }),
    gateDecisionId: "run-base",
    status: "full",
    canaryScope: null,
    releasedAt: "2026-09-01T00:00:00.000Z",
    rollbackOf: null,
  };

  it("新记录 rollbackOf 指向被回滚版本，diff 切回上一版快照", () => {
    const { failed, rollback } = createRollback(v2, v1Snapshot as never, "v3", "2026-09-29T00:00:00.000Z");
    expect(failed.status).toBe("rolled_back");
    expect(rollback.rollbackOf).toBe("v2");
    expect(rollback.diff).toBe(v1Snapshot.diff);
    expect(rollback.version).toBe("v3");
  });

  it("已回滚版本不可重复回滚", () => {
    const { failed } = createRollback(v2, v1Snapshot as never, "v3");
    expect(() => createRollback(failed, v1Snapshot as never, "v4")).toThrow("已是回滚状态");
  });
});
