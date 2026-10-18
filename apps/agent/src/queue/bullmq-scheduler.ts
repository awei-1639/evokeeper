/**
 * BullMQ 适配器（W4）—— 替换 InboxDeps.schedule 的进程内 setTimeout 注入
 *
 * 接口不变：返回的 schedule(delayMs, task) 语义与进程内 scheduler 一致
 * （延迟投递一次任务）。重试策略 RETRY_DELAYS_MS 仍由 inbox.ts 消费端控制——
 * 这里只负责"把一次带延迟的执行放进 Redis"，削峰归 BullMQ。
 *
 * 约定（design.md §2/§9）：
 *  - 队列名固定 "inbox-processing"；job 不携带可序列化数据，触发时执行
 *    进程内注册的闭包——函数不可序列化进 Redis，当前单进程部署形状下
 *    delayed job 只承担"削峰 + 到时唤醒"；跨进程拆分时改为投递
 *    deliveryId，worker 反查 PgInboxStore/TraceStore 重放；
 *  - REDIS_URL 走环境变量，未配置时构造即抛错（调用方回退进程内 scheduler）；
 *  - worker 并发 1：与"单实例串行消费"语义一致（claim 幂等保证多实例也安全）。
 */
import { Queue, Worker, type Job } from "bullmq";
import IORedis, { type Redis } from "ioredis";

export const INBOX_QUEUE_NAME = "inbox-processing";

export function resolveRedisUrl(explicit?: string): string {
  const url = explicit ?? process.env.REDIS_URL;
  if (!url) {
    throw new Error(
      "缺少 REDIS_URL 环境变量（本地默认 redis://localhost:6379，见 infra/docker-compose.yml）"
    );
  }
  return url;
}

export interface BullmqScheduler {
  /** 与 InboxDeps.schedule 签名一致：延迟 delayMs 后执行 task */
  schedule(delayMs: number, task: () => void | Promise<void>): void;
  /** 待触发的回调数（观测/测试用） */
  get pending(): number;
  /** 优雅关闭：停 worker、关队列与连接 */
  close(): Promise<void>;
}

export function createBullmqScheduler(options: {
  redisUrl?: string;
  queueName?: string;
} = {}): BullmqScheduler {
  const redisUrl = resolveRedisUrl(options.redisUrl);
  const queueName = options.queueName ?? INBOX_QUEUE_NAME;

  // maxRetriesPerRequest: null 是 BullMQ 官方要求（避免长阻塞命令被 ioredis 重试打断）
  const connection: Redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });

  const callbacks = new Map<string, () => void | Promise<void>>();
  let seq = 0;

  const queue = new Queue(queueName, { connection });
  const worker = new Worker<void>(
    queueName,
    async (job: Job<void>) => {
      const cb = job.id ? callbacks.get(job.id) : undefined;
      if (!cb) return; // 进程重启后遗留的 job：回调已失联，静默丢弃（幂等由 claim 层保证）
      callbacks.delete(job.id as string);
      await cb();
    },
    { connection, concurrency: 1 }
  );

  return {
    schedule(delayMs, task) {
      seq += 1;
      const jobId = `task-${seq}`;
      callbacks.set(jobId, task);
      void queue
        .add("run", undefined, {
          jobId,
          delay: Math.max(0, delayMs),
          removeOnComplete: { age: 3600, count: 1000 },
          removeOnFail: { age: 86_400 },
        })
        .catch((err: unknown) => {
          // 入队失败不能吞任务：立即就地执行，退化为进程内行为（至少一次投递语义）
          callbacks.delete(jobId);
          console.error(`[bullmq-scheduler] 入队失败，就地执行兜底:`, err);
          void task();
        });
    },
    get pending(): number {
      return callbacks.size;
    },
    async close() {
      callbacks.clear();
      await worker.close();
      await queue.close();
      connection.disconnect();
    },
  };
}
