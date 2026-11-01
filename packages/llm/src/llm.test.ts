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
import { createHttpTransport, createMockTransport } from "./client";
import { extractJson } from "./structured";
import { createLlm } from "./index";
import { classifyLlmError } from "./errors";
import { parseRateLimitCooldown } from "./client";

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
    // mc-1.4：triage 走 xxs 中转站的渠道别名（底层 DeepSeek-V4-Flash，但保真度 84% 已按换模型处理）
    expect(resolveModel("triage")).toBe("amd/deepseek-v4-flash");
    expect(resolveModel("judge")).toBe("glm-4.6");
    expect(DEFAULT_MODEL_CONFIG.version).toBe("mc-1.4");
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
    // 断言与路由一致而非硬编码模型名：换通道时只需改 config，测试不必跟着改
    expect(res.meta.model).toBe(resolveModel("triage"));
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

describe("base URL 环境变量覆盖（中转站支持）", () => {
  it("设置 DEEPSEEK_BASE_URL 后请求发往中转站地址", async () => {
    const captured: string[] = [];
    const original = process.env["DEEPSEEK_BASE_URL"];
    process.env["DEEPSEEK_BASE_URL"] = "https://relay.example.com/v1/";
    try {
      const transport = createHttpTransport({
        apiKeys: { deepseek: "test-key" },
        fetchImpl: (async (url: string | URL) => {
          captured.push(String(url));
          return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
        }) as typeof fetch,
      });
      await transport.chat({ model: "deepseek-v4-flash", system: "s", user: "u" });
    } finally {
      if (original === undefined) delete process.env["DEEPSEEK_BASE_URL"];
      else process.env["DEEPSEEK_BASE_URL"] = original;
    }
    expect(captured[0]).toBe("https://relay.example.com/v1/chat/completions");
  });

  it("未设置覆盖时走官方端点", async () => {
    const captured: string[] = [];
    const transport = createHttpTransport({
      apiKeys: { deepseek: "test-key" },
      fetchImpl: (async (url: string | URL) => {
        captured.push(String(url));
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
      }) as typeof fetch,
    });
    await transport.chat({ model: "deepseek-v4-flash", system: "s", user: "u" });
    expect(captured[0]).toBe("https://api.deepseek.com/chat/completions");
  });
});

describe("errors: 致命错误分类（2026-10-31 教训）", () => {
  const fatalSamples = [
    'LLM 调用失败 402: {"code":30001,"message":"Sorry, your account balance is insufficient"}',
    'LLM 调用失败 401: {"error":{"message":"Authentication Fails"}}',
    "LLM 调用失败 401: Invalid token",
    'LLM 调用失败 400: {"message":"unknown provider"}',
    'LLM 调用失败 503: {"message":"model_not_found"}',
    'LLM 调用失败 503: No available channel under group',
  ];
  for (const s of fatalSamples) {
    it(`判定为致命：${s.slice(0, 48)}`, () => {
      expect(classifyLlmError(s).fatal).toBe(true);
    });
  }

  const transientSamples = [
    "LLM 调用失败 429: rate limited",
    "LLM 调用失败 500: upstream error",
    "fetch failed",
    "The operation was aborted due to timeout",
  ];
  for (const s of transientSamples) {
    it(`不判定为致命：${s.slice(0, 40)}`, () => {
      expect(classifyLlmError(s).fatal).toBe(false);
    });
  }

  it("致命错误不重试（只调用 1 次），瞬时错误仍重试 3 次", async () => {
    let calls = 0;
    const failing = (message: string) => ({
      chat: () => {
        calls++;
        throw new Error(message);
      },
      embed: () => {
        throw new Error(message);
      },
    });
    const fatalLlm = createLlm({
      transport: failing('LLM 调用失败 402: {"message":"insufficient balance"}'),
      cache: null,
    });
    calls = 0;
    const fatalRes = await fatalLlm.json({
      purpose: "triage",
      system: "s",
      user: "u",
      validate: () => ({ ok: true as const, value: 1 }),
    });
    expect(fatalRes.ok).toBe(false);
    expect(fatalRes.meta.attempts).toBe(1);
    expect(calls).toBe(1);

    const transientLlm = createLlm({
      transport: failing("LLM 调用失败 500: upstream error"),
      cache: null,
    });
    calls = 0;
    const transientRes = await transientLlm.json({
      purpose: "triage",
      system: "s",
      user: "u",
      validate: () => ({ ok: true as const, value: 1 }),
    });
    expect(transientRes.ok).toBe(false);
    expect(transientRes.meta.attempts).toBe(3);
  });
});

describe("parseRateLimitCooldown: 频控文案解析（2026-11-01 教训）", () => {
  it("中文文案：请等待 N 秒", () => {
    expect(parseRateLimitCooldown("请求过于频繁，请等待 526 秒后再试")).toBe(526);
  });

  it("new-api 英文文案：maximum N requests in M minutes（xxs 实际返回）", () => {
    expect(
      parseRateLimitCooldown(
        '{"error":{"message":"You have reached the request limit: maximum 10 requests in 1 minutes (request id: ...)","type":"new_api_error"}}'
      )
    ).toBe(60);
  });

  it("英文秒/小时单位与 retry-after 头", () => {
    expect(parseRateLimitCooldown("maximum 3 requests in 20 seconds")).toBe(20);
    expect(parseRateLimitCooldown("maximum 5 requests in 1 hours")).toBe(900); // 上限 900 秒
    expect(parseRateLimitCooldown("Retry-After: 45")).toBe(45);
  });

  it("无冷却信息时返回 null（不能瞎猜，否则会误等）", () => {
    expect(parseRateLimitCooldown('{"message":"upstream error"}')).toBeNull();
    expect(parseRateLimitCooldown("")).toBeNull();
  });
});
