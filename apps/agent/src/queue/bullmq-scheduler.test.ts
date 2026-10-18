/**
 * BullMQ scheduler 集成测试（无 REDIS_URL 时整组 skip，CI 天然跳过）
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBullmqScheduler, type BullmqScheduler } from "./bullmq-scheduler";

const REDIS = process.env.REDIS_URL;
const d = describe.skipIf(!REDIS);

d("createBullmqScheduler", () => {
  let scheduler: BullmqScheduler;

  beforeAll(() => {
    scheduler = createBullmqScheduler({ redisUrl: REDIS, queueName: `inbox-it-${Date.now()}` });
  });

  afterAll(async () => {
    await scheduler.close();
  });

  it("schedule 延迟后执行回调", async () => {
    let executed = 0;
    scheduler.schedule(50, () => {
      executed += 1;
    });
    expect(scheduler.pending).toBe(1);
    await new Promise((r) => setTimeout(r, 1500));
    expect(executed).toBe(1);
    expect(scheduler.pending).toBe(0);
  }, 10_000);

  it("多个任务按各自延迟触发", async () => {
    const order: string[] = [];
    scheduler.schedule(300, () => {
      order.push("late");
    });
    scheduler.schedule(50, () => {
      order.push("early");
    });
    await new Promise((r) => setTimeout(r, 2000));
    expect(order).toEqual(["early", "late"]);
  }, 15_000);
});
