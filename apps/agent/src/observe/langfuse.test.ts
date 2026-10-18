/**
 * Langfuse exporter 工厂单元测试（不依赖真实服务：no-op 路径 + 配置检测）
 */
import { afterEach, describe, expect, it } from "vitest";
import { createTraceExporter, isLangfuseConfigured } from "./langfuse";

function clearEnv(): void {
  delete process.env.LANGFUSE_PUBLIC_KEY;
  delete process.env.LANGFUSE_SECRET_KEY;
  delete process.env.LANGFUSE_HOST;
}

describe("createTraceExporter", () => {
  afterEach(clearEnv);

  it("未配置 key 时返回 no-op exporter（export/flush 不抛错）", async () => {
    clearEnv();
    expect(isLangfuseConfigured()).toBe(false);
    const exporter = createTraceExporter();
    await expect(
      exporter.export({
        id: "trace-x",
        repo: "a/b",
        issueNumber: 1,
        agentVersion: "0.1.0",
        issueExcerpt: null,
        steps: [],
        finalActions: [],
        totalCost: 0,
        totalTokens: 0,
        startedAt: "2026-10-18T00:00:00Z",
        finishedAt: "2026-10-18T00:00:01Z",
      })
    ).resolves.toBeUndefined();
    await expect(exporter.flush()).resolves.toBeUndefined();
  });
});
