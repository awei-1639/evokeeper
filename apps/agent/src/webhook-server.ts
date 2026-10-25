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
import { buildTrace, JsonlTraceStore, type TraceStore } from "./trace-store";
import type { TraceExporter } from "./observe/langfuse";
import {
  DryRunGithubClient,
  executeActions,
  RestGithubClient,
  StaticToken,
  type GithubClient,
} from "./github-client";
import { githubAppAuthFromEnv } from "./github-app-auth";
import { createQaAwareHandle } from "./qa-hook";
import { createLlm, liveModelConfigFromEnv } from "@evokeeper/llm";
import { JsonlAuditStore, type AuditStore } from "@evokeeper/gateway";

/** gateway 审计落盘位置（相对进程 cwd；生产可换 PG 实现） */
const GITHUB_AUDIT_PATH = "datasets/gateway/audit.jsonl";

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
  /**
   * GitHub 执行通道（W4 真实流量）：传入后处理完成的动作经 gateway 治理真实执行。
   * 缺省时自动装配——GITHUB_APP_ID/PRIVATE_KEY/INSTALLATION_ID 三元组齐 → App 认证；
   * 否则有 GITHUB_TOKEN → PAT；都没有 → dry-run（评测/本地调试）。
   */
  github?: GithubClient;
  /** 动作执行器使用的审计存储（R3：允许与否都留痕 + 冷却判定历史） */
  auditStore?: AuditStore;
  log?: (msg: string) => void;
}

/** 按环境自动选择 GitHub 执行通道：App installation > PAT > DryRun */
export function resolveGithubClient(log: (msg: string) => void = () => {}): GithubClient {
  const appAuth = githubAppAuthFromEnv();
  if (appAuth) {
    log("[github] GitHub App 认证（installation token，1h 缓存）");
    return new RestGithubClient(appAuth);
  }
  if (process.env.GITHUB_TOKEN) {
    log("[github] PAT 认证（GITHUB_TOKEN）");
    return new RestGithubClient(new StaticToken(process.env.GITHUB_TOKEN));
  }
  log("[github] 未配置凭据 → DryRun（动作只记录不外发）");
  return new DryRunGithubClient();
}

export function createWebhookServer(options: WebhookServerOptions = {}): Server {
  const log = options.log ?? (() => {});
  const { traceStore, traceExporter, github, auditStore, ...inboxDeps } = options;
  // GitHub 执行通道：显式传入 > 环境自动装配（App > PAT > DryRun）
  const githubClient = github ?? resolveGithubClient(log);
  const gatewayAudit = auditStore ?? new JsonlAuditStore(GITHUB_AUDIT_PATH);
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
      // W4 真实执行：动作经 gateway 治理（幂等/冷却/配额）后触达 GitHub（DryRun 模式只记录）
      void executeActions({
        repo: event.repo,
        issueNumber: event.issueNumber,
        traceId: `trace-${delivery.eventId}`,
        actions: result.actions,
        history: [],
        github: githubClient,
        auditStore: gatewayAudit,
      })
        .then((exec) => {
          const skipped = exec.executed.filter((e) => !e.ok).length;
          if (skipped > 0) log(`[gateway] ${delivery.eventId} 拦截 ${skipped} 个动作`);
        })
        .catch((err) => {
          const cause = err instanceof Error && err.cause instanceof Error ? `（cause: ${err.cause.message}）` : "";
          log(`[gateway] 动作执行失败：${String(err)}${cause}`);
        });
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
  const log = (msg: string) => console.log(msg);
  // R3：真实流量轨迹与 744 条历史轨迹同库（datasets/traces/traces.jsonl），scan:daily 统一消费
  const traceStore = new JsonlTraceStore("datasets/traces/traces.jsonl");

  // 模型路由按环境可用性降级（§9.1；answer/judge 档无对应 Key 时换 deepseek-v4-pro 并如实 log）
  const llm = createLlm({ config: liveModelConfigFromEnv(log) });

  // 问答钩子：BM25 语料（nacos 300 条）+ 引用护栏；初始化失败不阻断分诊主链路
  let handle: NonNullable<Parameters<typeof createWebhookServer>[0]>["handle"];
  try {
    handle = createQaAwareHandle({ llm, log });
  } catch (err) {
    log(`[qa] 语料加载失败，问答钩子停用（分诊不受影响）：${String(err).slice(0, 120)}`);
  }

  createWebhookServer({
    port,
    traceStore,
    log,
    ...(handle ? { handle } : {}),
  }).listen(port, () => {
    console.log(`EvoKeeper webhook 接入已启动: http://localhost:${port}/webhook (healthz: /healthz)`);
    console.log(`[trace] 轨迹落库 -> datasets/traces/traces.jsonl`);
  });
}
