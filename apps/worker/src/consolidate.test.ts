/**
 * 睡眠整理管线测试
 *
 * 锁死 design.md §6 契约：
 * unclear 绝不入管线（双保险）；硬分组（主标签）→ 组内聚类 → 低频簇不成候选；
 * 候选带完整证据链（evidenceTraceIds = 簇内轨迹 id）；maxCandidates 评审预算；
 * job 快照可重放（inputTraceIds + clusterParams + judgeRuleVersion）。
 */
import { describe, expect, it } from "vitest";
import { createLlm, createMockTransport } from "@evokeeper/llm";
import type { FailureVerdict, JudgedTrace, Trace } from "@evokeeper/core";
import { clusterBySimilarity, runConsolidation } from "./consolidate";

function makeJudged(
  id: string,
  label: string,
  excerpt: string,
  verdict: FailureVerdict = "failure"
): JudgedTrace {
  const trace: Trace = {
    id,
    repo: "alibaba/nacos",
    issueNumber: Number(id.replace(/\D/g, "")) || 1,
    agentVersion: "0.1.0",
    issueExcerpt: excerpt,
    steps: [],
    finalActions: [{ kind: "addLabels", labels: [label as "bug"] }],
    totalCost: 0.004,
    totalTokens: 1580,
    startedAt: "2026-09-20T00:00:00.000Z",
    finishedAt: "2026-09-20T00:00:05.000Z",
  };
  return {
    trace,
    reactions: [],
    verdict,
    judgeRuleVersion: "jrv-1.0",
    humanReviewed: false,
  };
}

const BUG_A = "构建失败 因 JDK 版本与编译插件不兼容 报错 unsupported class file version";
const BUG_A2 = "构建失败 JDK 25 与编译插件不兼容 报 unsupported class file version 错误";
const BUG_A3 = "构建失败 编译插件与 JDK 版本不兼容 导致 class file version 报错";

function mockLlm() {
  return createLlm({
    transport: createMockTransport({
      chat: () => ({
        content: JSON.stringify({
          type: "skill",
          pattern: "JDK 版本高于编译插件支持范围时构建失败，应先核对版本矩阵",
          content: "1) 核对 JDK 与编译插件版本矩阵 2) 升级插件或降级 JDK",
          expectedSlice: "labels=bug & topic=build-error",
        }),
        inputTokens: 800,
        outputTokens: 100,
        cachedInputTokens: 0,
      }),
    }),
  });
}

describe("clusterBySimilarity", () => {
  it("两个主题各自聚成一簇", () => {
    const clusters = clusterBySimilarity(
      [
        "MCP 工具注册失败 swagger 路径缺失",
        "MCP 工具注册 swagger 暴露路径问题",
        BUG_A,
        BUG_A2,
        BUG_A3,
      ],
      0.5
    );
    const sizes = clusters.map((c) => c.memberIndexes.length).sort((a, b) => b - a);
    expect(sizes).toEqual([3, 2]);
  });

  it("阈值过高时全部保持单例", () => {
    const clusters = clusterBySimilarity([BUG_A, BUG_A2, BUG_A3], 0.999);
    expect(clusters).toHaveLength(3);
  });
});

describe("runConsolidation", () => {
  it("端到端：unclear 被过滤、同簇 3 条成候选、证据链完整、job 快照可重放", async () => {
    const judged = [
      makeJudged("trace-101", "bug", BUG_A),
      makeJudged("trace-102", "bug", BUG_A2),
      makeJudged("trace-103", "bug", BUG_A3),
      makeJudged("trace-104", "bug", "完全无关的另一条 issue 内容", "unclear"),
    ];
    const { job, candidates, rejected } = await runConsolidation({
      repo: "alibaba/nacos",
      judged,
      llm: mockLlm(),
      now: "2026-09-28T00:00:00.000Z",
    });

    expect(job.status).toBe("completed");
    expect(job.inputTraceIds).toEqual(["trace-101", "trace-102", "trace-103"]);
    expect(job.judgeRuleVersion).toBe("jrv-1.0");
    expect(job.clusterParams).toEqual({ minClusterSize: 3, similarityThreshold: 0.82, maxCandidates: 10 });
    expect(job.finishedAt).not.toBeNull();

    expect(candidates).toHaveLength(1);
    const cand = candidates[0]!;
    expect(cand.status).toBe("proposed");
    expect(cand.evidenceTraceIds).toEqual(["trace-101", "trace-102", "trace-103"]);
    expect(cand.consolidationJobId).toBe(job.id);
    expect(job.candidateIds).toEqual([cand.id]);
    expect(rejected).toHaveLength(0);
    expect(job.lowFrequencyClusters).toHaveLength(0);
  });

  it("簇不足 minClusterSize → 低频簇记录，不成候选", async () => {
    const judged = [
      makeJudged("trace-201", "bug", BUG_A),
      makeJudged("trace-202", "bug", BUG_A2),
      makeJudged("trace-203", "bug", BUG_A3),
      makeJudged("trace-204", "bug", "Nacos 控制台页面显示乱码 编码设置问题"),
    ];
    const { job, candidates } = await runConsolidation({
      repo: "alibaba/nacos",
      judged,
      llm: mockLlm(),
    });
    expect(candidates).toHaveLength(1);
    expect(job.lowFrequencyClusters).toEqual([
      { size: 1, sampleTraceIds: ["trace-204"] },
    ]);
  });

  it("maxCandidates 评审预算：多簇时只产出限额内的候选", async () => {
    const judged = [
      makeJudged("trace-301", "bug", BUG_A),
      makeJudged("trace-302", "bug", BUG_A2),
      makeJudged("trace-303", "bug", BUG_A3),
      makeJudged("trace-304", "question", "MCP 工具注册失败 swagger 路径问题 A"),
      makeJudged("trace-305", "question", "MCP 工具注册 swagger 暴露路径问题 B"),
      makeJudged("trace-306", "question", "MCP 注册 swagger 路径 C"),
    ];
    const { job, candidates } = await runConsolidation({
      repo: "alibaba/nacos",
      judged,
      llm: mockLlm(),
      clusterParams: { maxCandidates: 1 },
    });
    expect(candidates).toHaveLength(1);
    expect(job.candidateIds).toHaveLength(1);
  });

  it("LLM 归纳失败 → 记入 rejected，job 仍完成（绝不静默降级）", async () => {
    const brokenLlm = createLlm({
      transport: createMockTransport({
        chat: () => ({ content: "不是 JSON", inputTokens: 100, outputTokens: 10, cachedInputTokens: 0 }),
      }),
    });
    const judged = [
      makeJudged("trace-401", "bug", BUG_A),
      makeJudged("trace-402", "bug", BUG_A2),
      makeJudged("trace-403", "bug", BUG_A3),
    ];
    const { job, candidates, rejected } = await runConsolidation({
      repo: "alibaba/nacos",
      judged,
      llm: brokenLlm,
    });
    expect(candidates).toHaveLength(0);
    expect(rejected[0]?.reason).toContain("归纳失败");
    expect(job.status).toBe("completed");
    expect(job.candidateIds).toHaveLength(0);
  });

  it("全 unclear 输入 → 空 job（不成任何候选）", async () => {
    const { job, candidates } = await runConsolidation({
      repo: "alibaba/nacos",
      judged: [makeJudged("trace-501", "bug", BUG_A, "unclear")],
      llm: mockLlm(),
    });
    expect(job.inputTraceIds).toHaveLength(0);
    expect(candidates).toHaveLength(0);
  });
});
