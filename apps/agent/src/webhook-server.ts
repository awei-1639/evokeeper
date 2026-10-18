/**
 * Webhook 接入服务（W2）—— design.md §2 用户面
 *
 * 职责：接收 GitHub webhook → 校验签名 → 交给 Inbox 幂等接入 → 立即响应。
 * 不做业务判断；处理（LLM 调用、动作决策）由 Inbox 异步调度。
 *
 * 运行：pnpm --filter @evokeeper/agent dev   （需 Node 22+）
 * 环境变量：PORT（默认 8787）、GITHUB_WEBHOOK_SECRET（配置后强制校验
 * X-Hub-Signature-256；未配置时打印警告并以 dev 模式接受，仅限本地调试）。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  createInboxProcessor,
  verifyWebhookSignature,
  type InboxDeps,
  type InboxProcessor,
} from "./inbox";
import { buildTrace, type TraceStore } from "./trace-store";
import type { TraceExporter } from "./observe/langfuse";

const MAX_BODY_BYTES = 1024 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

export interface WebhookServerOptions extends InboxDeps {
  port?: number;
  /** 未传时读 GITHUB_WEBHOOK_SECRET；为空则 dev 模式（不验签，仅本地调试） */
  secret?: string;
  /** 轨迹库（R3）：传入后每次处理完成自动落库，trace id = GitHub delivery id */
  traceStore?: TraceStore;
  /** 观测导出（W4）：传入后 Trace 落库同时上报（Langfuse 等；失败只打日志不影响主链路） */
  traceExporter?: TraceExporter;
  log?: (msg: string) => void;
}

export function createWebhookServer(options: WebhookServerOptions = {}): Server {
  const log = options.log ?? (() => {});
  const { traceStore, traceExporter, ...inboxDeps } = options;
  const processor: InboxProcessor = createInboxProcessor({
    ...inboxDeps,
    onProcessed: (delivery, event, result) => {
      inboxDeps.onProcessed?.(delivery, event, result);
      if (traceStore || traceExporter) {
        const trace = buildTrace(event, result, { id: `trace-${delivery.eventId}` });
        if (traceStore) {
          void traceStore
            .append(trace)
            .catch((err) => log(`[trace] 落库失败：${String(err)}`));
        }
        if (traceExporter) {
          void traceExporter
            .export(trace)
            .catch((err) => log(`[observe] Langfuse 上报失败：${String(err)}`));
        }
      }
    },
  });
  const secret = options.secret ?? process.env.GITHUB_WEBHOOK_SECRET ?? "";

  return createServer(async (req, res) => {
    const url = req.url ?? "";
    if (req.method === "GET" && (url === "/healthz" || url === "/healthz/")) {
      respond(res, 200, { ok: true });
      return;
    }
    if (req.method !== "POST" || (url !== "/webhook" && url !== "/webhook/")) {
      respond(res, 404, { error: "not found" });
      return;
    }

    const deliveryId = req.headers["x-github-delivery"];
    const eventName = req.headers["x-github-event"];
    if (typeof deliveryId !== "string" || typeof eventName !== "string") {
      respond(res, 400, { error: "missing x-github-delivery / x-github-event headers" });
      return;
    }

    let rawBody: string;
    try {
      rawBody = await readBody(req);
    } catch {
      respond(res, 413, { error: "payload too large or unreadable" });
      return;
    }

    if (secret) {
      const sig = req.headers["x-hub-signature-256"];
      if (!verifyWebhookSignature(secret, rawBody, typeof sig === "string" ? sig : undefined)) {
        respond(res, 401, { error: "invalid signature" });
        return;
      }
    } else {
      log("[warn] GITHUB_WEBHOOK_SECRET 未配置，跳过签名校验（仅限本地调试）");
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      respond(res, 400, { error: "invalid JSON payload" });
      return;
    }

    const outcome = await processor.ingest({ eventId: deliveryId, eventName, payload });
    log(`[inbox] ${eventName} delivery=${deliveryId} -> ${outcome.status}`);
    respond(res, 202, { status: outcome.status });
  });
}

/** 独立启动入口：tsx apps/agent/src/webhook-server.ts */
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop() ?? "?");
if (isMain) {
  const port = Number(process.env.PORT ?? 8787);
  createWebhookServer({ port }).listen(port, () => {
    console.log(`EvoKeeper webhook 接入已启动: http://localhost:${port}/webhook (healthz: /healthz)`);
  });
}
