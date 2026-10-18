/**
 * Langfuse 观测适配器（W4）—— design.md §9 L203
 *
 * 契约：Langfuse 以 Trace 为 session、steps 为 span/generation，字段含
 * promptVersion / agentVersion / cost / tokens。
 *
 * 降级策略：LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY 未配置时返回 no-op
 * exporter（本地开发/CI 不依赖 Langfuse 在线服务；infra 容器 3001 端口可选接入）。
 *
 * 上报入口：webhook-server onProcessed 后与 Trace 落库并行调用——观测失败
 * 只打日志，不影响主链路（R3 落库是事实源，Langfuse 是观测副本）。
 */
import { Langfuse, type LangfuseTraceClient } from "langfuse";
import type { Trace } from "@evokeeper/core";

export interface TraceExporter {
  /** 上报一条完整 Trace（fire-and-forget：内部吞错，调用方无需 await 成败） */
  export(trace: Trace): Promise<void>;
  /** 进程退出前刷缓冲 */
  flush(): Promise<void>;
}

export function isLangfuseConfigured(): boolean {
  return Boolean(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY);
}

/** langfuse SDK 要求 host 无尾斜杠 */
function normalizeHost(host: string | undefined): string {
  const h = host ?? "http://localhost:3001";
  return h.endsWith("/") ? h.slice(0, -1) : h;
}

class LangfuseTraceExporter implements TraceExporter {
  private readonly client: Langfuse;

  constructor() {
    this.client = new Langfuse({
      publicKey: process.env.LANGFUSE_PUBLIC_KEY as string,
      secretKey: process.env.LANGFUSE_SECRET_KEY as string,
      baseUrl: normalizeHost(process.env.LANGFUSE_HOST),
    });
  }

  async export(trace: Trace): Promise<void> {
    const lfTrace: LangfuseTraceClient = this.client.trace({
      id: trace.id,
      name: "issue-triage",
      sessionId: trace.repo,
      metadata: {
        agentVersion: trace.agentVersion,
        issueNumber: trace.issueNumber,
        totalCost: trace.totalCost,
        totalTokens: trace.totalTokens,
      },
      // 统一嵌入 design.md §9 固定日志字段（traceId/repo/issueNumber/agentVersion）
      tags: [trace.repo, `agent:${trace.agentVersion}`],
    });

    for (const step of trace.steps) {
      if (step.kind === "llm") {
        lfTrace.generation({
          name: `step-${step.seq}`,
          model: step.model ?? undefined,
          startTime: new Date(step.startedAt),
          endTime: new Date(Date.parse(step.startedAt) + step.durationMs),
          usage: { input: step.inputTokens, output: step.outputTokens },
          metadata: {
            promptVersion: step.promptVersion,
            costAmount: step.costAmount,
            latencyMs: step.durationMs,
          },
        });
      } else {
        lfTrace.span({
          name: `step-${step.seq}:${step.kind}`,
          startTime: new Date(step.startedAt),
          endTime: new Date(Date.parse(step.startedAt) + step.durationMs),
          metadata: {
            promptVersion: step.promptVersion,
            toolSummary: step.toolSummary,
            latencyMs: step.durationMs,
          },
        });
      }
    }

    for (const action of trace.finalActions) {
      lfTrace.span({
        name: `action:${action.kind}`,
        metadata: action.kind === "comment" ? { quoteRefs: action.quoteRefs } : {},
      });
    }
  }

  async flush(): Promise<void> {
    await this.client.flushAsync();
  }
}

class NoopTraceExporter implements TraceExporter {
  async export(): Promise<void> {
    /* Langfuse 未配置：观测关闭，R3 落库不受影响 */
  }
  async flush(): Promise<void> {
    /* no-op */
  }
}

/** 工厂：按环境变量自动选择真实现或 no-op */
export function createTraceExporter(): TraceExporter {
  return isLangfuseConfigured() ? new LangfuseTraceExporter() : new NoopTraceExporter();
}
