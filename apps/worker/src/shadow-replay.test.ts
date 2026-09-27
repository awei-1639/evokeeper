/**
 * 影子回放测试（第 6 道门禁）
 *
 * 锁死：一致率口径（主标签比对）、解析失败计为不一致（判错不豁免）、阈值判定。
 */
import { describe, expect, it } from "vitest";
import { replayShadow, type ReplaySnapshot } from "./shadow-replay";

const SNAPSHOTS: ReplaySnapshot[] = [
  { caseId: "1", title: "t", body: "b", historicalMain: "bug" },
  { caseId: "2", title: "t", body: "b", historicalMain: "question" },
  { caseId: "3", title: "t", body: "b", historicalMain: "feature" },
  { caseId: "4", title: "t", body: "b", historicalMain: "bug" },
];

describe("replayShadow", () => {
  it("全部一致 → passed", async () => {
    const r = await replayShadow({
      snapshots: SNAPSHOTS,
      runVersion: async (s) => ({
        labels: [{ "1": "bug", "2": "question", "3": "feature", "4": "bug" }[s.caseId] ?? "question"],
      }),
    });
    expect(r.agreementRate).toBe(1);
    expect(r.passed).toBe(true);
  });

  it("一致率低于阈值 → failed，不一致清单带历史与重放结果", async () => {
    const r = await replayShadow({
      snapshots: SNAPSHOTS,
      runVersion: async (s) => ({
        labels: [s.caseId === "1" ? "question" : ({ "2": "question", "3": "feature", "4": "bug" }[s.caseId] ?? "bug")],
      }),
      minAgreementRate: 0.95,
    });
    expect(r.agreementRate).toBe(0.75);
    expect(r.passed).toBe(false);
    expect(r.disagreements).toEqual([{ caseId: "1", historical: "bug", replayed: "question" }]);
  });

  it("解析失败（null）计为不一致——判错不豁免", async () => {
    const r = await replayShadow({
      snapshots: SNAPSHOTS.slice(0, 2),
      runVersion: async (s) => ({ labels: s.caseId === "1" ? ["bug"] : null }),
      minAgreementRate: 0.95,
    });
    expect(r.agreementRate).toBe(0.5);
    expect(r.disagreements[0]?.replayed).toBeNull();
  });

  it("空输入默认通过（无可回放对象不构成阻塞）", async () => {
    const r = await replayShadow({ snapshots: [], runVersion: async () => ({ labels: null }) });
    expect(r.passed).toBe(true);
    expect(r.agreementRate).toBe(1);
  });
});
