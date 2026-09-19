/**
 * packages/llm 行为契约测试
 *
 * 这里锁死三条容易在后续重构中被破坏的约束：
 * 1. 计价必须体现 DeepSeek 峰谷（差 2 倍），否则成本归因失真；
 * 2. judge / consolidate 绝不缓存（TTL=0），否则评测不可复现；
 * 3. 结构化输出校验失败必须重试后失败（ok:false），绝不静默降级。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_CONFIG,
  MODEL_SPECS,
  beijingHour,
  estimateCost,
  getSpec,
  isOffPeakNow,
  resolveModel,
} from "./config";
import { buildCacheKey, createMemoryCache, normalizeInput } from "./cache";
import { createMockTransport } from "./client";
import { extractJson } from "./structured";
import { createLlm } from "./index";

/** 北京时间 10:00（高峰） */
const PEAK = new Date("2026-09-14T02:00:00Z");
/** 北京时间 03:00（空闲） */
const OFF_PEAK = new Date("2026-09-13T19:00:00Z");

describe("config: 峰谷计价", () => {
  it("北京时间换算正确", () => {
    expect(beijingHour(PEAK)).toBe(10);
    expect(beijingHour(OFF_PEAK)).toBe(3);
  });

  it("高峰价恰为空闲价的 2 倍", () => {
    const input = { model: "deepseek-v4-flash", inputTokens: 1000, outputTokens: 500 };
    const peak = estimateCost({ ...input, at: PEAK });
    const off = estimateCost({ ...input, at: OFF_PEAK });
    expect(peak).toBeCloseTo(off * 2, 10);
    expect(off).toBeCloseTo(0.00375, 10);
  });

  it("命中缓存的输入按缓存价计（远低于原价）", () => {
    const fresh = estimateCost({
      model: "deepseek-v4-flash",
      inputTokens: 1000,
      outputTokens: 0,
      at: OFF_PEAK,
    });
    const cached = estimateCost({
      model: "deepseek-v4-flash",
      inputTokens: 1000,
      cachedInputTokens: 1000,
      outputTokens: 0,
      at: OFF_PEAK,
    });
    expect(cached).toBeLessThan(fresh / 10);
  });

  it("未登记的模型必须显式报错，不能按 0 元静默放行", () => {
    expect(() => getSpec("gpt-5-nano")).toThrow(/未知模型/);
  });

  it("purpose 路由与配置版本快照", () => {
    expect(resolveModel("triage")).toBe("deepseek-v4-flash");
    expect(resolveModel("judge")).toBe("glm-4.6");
    expect(DEFAULT_MODEL_CONFIG.version).toBe("mc-1.0");
    // judge 与 answer 必须跨厂商，防自偏好偏差（design.md §7.1）
    expect(MODEL_SPECS[resolveModel("judge")]?.provider).not.toBe(
      MODEL_SPECS[resolveModel("answer")]?.provider
    );
  });

  it("批量任务可据此判断空闲时段", () => {
    expect(isOffPeakNow(PEAK, "deepseek-v4-pro")).toBe(false);
    expect(isOffPeakNow(OFF_PEAK, "deepseek-v4-pro")).toBe(true);
  });
});

describe("cache: 键构造", () => {
  it("空白与大小写差异不应击穿缓存", () => {
    const a = buildCacheKey({
      configVersion: "mc-1.0",
      purpose: "triage",
      model: "m",
      system: "  Hello   World ",
      user: "ABC",
    });
    const b = buildCacheKey({
      configVersion: "mc-1.0",
      purpose: "triage",
      model: "m",
      system: "hello world",
      user: "abc",
    });
    expect(a).toBe(b);
  });

  it("配置版本变更必须换键（换模型 = 换行为）", () => {
    const key = (v: string) =>
      buildCacheKey({ configVersion: v, purpose: "triage", model: "m", system: "s", user: "u" });
    expect(key("mc-1.0")).not.toBe(key("mc-1.1"));
  });

  it("ttl<=0 不写入（judge / consolidate 依赖此行为）", async () => {
    const cache = createMemoryCache();
    await cache.set("k", "v", 0);
    expect(await cache.get("k")).toBeNull();
  });

  it("过期后读取返回 null", async () => {
    const cache = createMemoryCache();
    await cache.set("k", "v", 10);
    await new Promise((r) => setTimeout(r, 30));
    expect(await cache.get("k")).toBeNull();
  });

  it("normalizeInput 压缩空白", () => {
    expect(normalizeInput("  a\n  b  ")).toBe("a b");
  });
});

describe("structured: JSON 提取", () => {
  it("处理 fenced / 前后废话 / 裸 JSON", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('好的：{"a":1} 以上')).toEqual({ a: 1 });
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson("完全不是 JSON")).toBeNull();
  });
});

const VALID = '{"ok":true}';
const validator = (v: unknown) =>
  typeof v === "object" && v !== null && (v as { ok?: unknown }).ok === true
    ? ({ ok: true as const, value: v as { ok: boolean } })
    : ({ ok: false as const, error: "缺少 ok:true" });

describe("structured: completeJson 行为", () => {
  it("成功调用返回 meta，且成本与 token 可归因", async () => {
    const llm = createLlm({
      transport: createMockTransport({
        chat: () => ({
          content: VALID,
          inputTokens: 1200,
          outputTokens: 60,
          cachedInputTokens: 0,
        }),
      }),
    });
    const res = await llm.json({
      purpose: "triage",
      promptVersion: "tp-1.0",
      system: "s",
      user: "u",
      validate: validator,
    });
    expect(res.ok).toBe(true);
    expect(res.meta.model).toBe("deepseek-v4-flash");
    expect(res.meta.promptVersion).toBe("tp-1.0");
    expect(res.meta.inputTokens).toBe(1200);
    expect(res.meta.costAmount).toBeGreaterThan(0);
    expect(res.meta.attempts).toBe(1);
  });

  it("校验失败：重试 2 次后仍失败，返回 ok:false 而非降级", async () => {
    let calls = 0;
    const llm = createLlm({
      transport: createMockTransport({
        chat: () => {
          calls += 1;
          return { content: "不是 JSON", inputTokens: 10, outputTokens: 10, cachedInputTokens: 0 };
        },
      }),
    });
    const res = await llm.json({
      purpose: "triage",
      system: "s",
      user: "u",
      validate: validator,
    });
    expect(calls).toBe(3);
    expect(res.ok).toBe(false);
    expect(res.data).toBeNull();
    expect(res.error).toBeTruthy();
    expect(res.meta.attempts).toBe(3);
  });

  it("triage 命中缓存：第二次不计费不请求", async () => {
    let calls = 0;
    const llm = createLlm({
      transport: createMockTransport({
        chat: () => {
          calls += 1;
          return { content: VALID, inputTokens: 100, outputTokens: 10, cachedInputTokens: 0 };
        },
      }),
    });
    const args = { purpose: "triage" as const, system: "s", user: "u", validate: validator };
    await llm.json(args);
    const second = await llm.json(args);
    expect(calls).toBe(1);
    expect(second.meta.cacheHit).toBe(true);
    expect(second.meta.costAmount).toBe(0);
  });

  it("judge 永不缓存：两次调用都真实请求（评测可复现的前提）", async () => {
    let calls = 0;
    const llm = createLlm({
      transport: createMockTransport({
        chat: () => {
          calls += 1;
          return { content: VALID, inputTokens: 100, outputTokens: 10, cachedInputTokens: 0 };
        },
      }),
    });
    const args = { purpose: "judge" as const, system: "s", user: "u", validate: validator };
    await llm.json(args);
    await llm.json(args);
    expect(calls).toBe(2);
    expect(MODEL_SPECS[resolveModel("judge")]?.provider).toBe("zhipu");
  });
});
