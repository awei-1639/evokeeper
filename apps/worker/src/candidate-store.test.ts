/**
 * 候选经验存储测试（评审队列的状态流转契约）
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExperienceCandidate } from "@evokeeper/core";
import { JsonlCandidateStore } from "./candidate-store";

function makeCandidate(id: string, status: ExperienceCandidate["status"] = "proposed", createdAt = "2026-09-28T00:00:00.000Z"): ExperienceCandidate {
  return {
    id,
    type: "skill",
    repo: "alibaba/nacos",
    pattern: "构建失败先核对 JDK 与插件版本矩阵",
    content: "1) 查版本矩阵 2) 升级插件",
    expectedSlice: "labels=bug & topic=build-error",
    evidenceTraceIds: ["trace-1", "trace-2", "trace-3"],
    consolidationJobId: "job-1",
    status,
    createdAt,
  };
}

describe("JsonlCandidateStore", () => {
  it("append / list / get；重复 id 拒绝", async () => {
    const store = new JsonlCandidateStore(join(mkdtempSync(join(tmpdir(), "evokeeper-cand-")), "c.jsonl"));
    await store.append(makeCandidate("cand-1"));
    await store.append(makeCandidate("cand-2", "proposed", "2026-09-29T00:00:00.000Z"));
    expect((await store.list()).map((c) => c.id)).toEqual(["cand-2", "cand-1"]); // 时间倒序
    expect((await store.get("cand-1"))?.pattern).toContain("版本矩阵");
    await expect(store.append(makeCandidate("cand-1"))).rejects.toThrow("重复");
  });

  it("评审状态流转：proposed → approved → released 阶段由发布器写入", async () => {
    const store = new JsonlCandidateStore(join(mkdtempSync(join(tmpdir(), "evokeeper-cand-")), "c.jsonl"));
    await store.append(makeCandidate("cand-1"));
    const approved = await store.updateStatus("cand-1", "approved");
    expect(approved.status).toBe("approved");
    const rejected = await store.updateStatus("cand-1", "rejected");
    expect(rejected.status).toBe("rejected");
    await expect(store.updateStatus("cand-x", "approved")).rejects.toThrow("不存在");
  });

  it("跨实例恢复（重启不丢评审结果）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "evokeeper-cand-"));
    const file = join(dir, "c.jsonl");
    const store1 = new JsonlCandidateStore(file);
    await store1.append(makeCandidate("cand-1"));
    await store1.updateStatus("cand-1", "approved");
    const store2 = new JsonlCandidateStore(file);
    expect((await store2.get("cand-1"))?.status).toBe("approved");
  });
});
