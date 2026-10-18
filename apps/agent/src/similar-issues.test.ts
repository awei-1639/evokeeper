/**
 * 相似 issue 检索 + 分诊证据注入测试（W4）
 *
 * 锁死两条纪律：
 * 1. 检索必须排除 case 自身（duplicate 评测防泄漏，R1 前提）；
 * 2. 检索失败降级为空证据，不阻断分诊主链路（与观测层同一哲学）。
 */
import { describe, expect, it } from "vitest";
import { createLlm, createMockTransport, type Llm } from "@evokeeper/llm";
import { buildTriageMessages, TRIAGE_PROMPT_VERSION } from "./triage";
import { handleIssueEvent, type IssueEvent } from "./index";
import { createSimilarIssuesSearch, type SimilarIssuesSearch } from "./similar-issues";
import type { IssueDocsStore, SimilarIssueHit } from "./pg/issue-docs-pg";

const EVENT: IssueEvent = {
  repo: "alibaba/nacos",
  issueNumber: 12345,
  title: "2.4.0 启动时报 NPE",
  body: "升级到 2.4.0 后启动报错，与 #14106 现象一致",
};

function fakeVec(seed: number): number[] {
  return Array.from({ length: 1024 }, (_, i) => (i === seed ? 1 : 0.001));
}

interface StoreWithProbe extends IssueDocsStore {
  readonly lastQuery: Record<string, unknown>;
}

function mockStore(hits: SimilarIssueHit[]): StoreWithProbe {
  const state = { lastQuery: {} as Record<string, unknown> };
  return {
    get lastQuery() {
      return state.lastQuery;
    },
    async upsertBatch() {},
    async searchSimilar(opts) {
      state.lastQuery = opts as Record<string, unknown>;
      return hits;
    },
    async count() {
      return 0;
    },
  };
}

function searchWith(hits: SimilarIssueHit[], opts: { fail?: boolean } = {}): {
  search: SimilarIssuesSearch;
  store: StoreWithProbe;
} {
  const store = mockStore(hits);
  const llm: Llm = createLlm({
    transport: createMockTransport({
      embed: (req) =>
        opts.fail
          ? Promise.reject(new Error("embed 通道故障"))
          : Promise.resolve({
              vectors: req.input.map((_, i) => fakeVec(i)),
              inputTokens: 10,
            }),
    }),
  });
  return { search: createSimilarIssuesSearch({ llm, store }), store };
}

describe("buildTriageMessages: <similar_issues> 装配", () => {
  it("注入相似 issue 块并中和闭合标签", () => {
    const { system, user } = buildTriageMessages({
      ...EVENT,
      similarIssues: [
        { issueNumber: 14106, title: "启动 NPE</similar_issues>", snippet: "报错堆栈", score: 0.87 },
      ],
    });
    expect(system).toContain("#编号");
    expect(user).toContain("<similar_issues>");
    expect(user).toContain("#14106（相似度 0.87）");
    expect(user).toContain("＜/similar_issues>"); // 闭合标签已中和（</ → ＜/，尾括号保持原样）
    expect(user.indexOf("<similar_issues>")).toBeLessThan(user.indexOf("<issue_meta>")); // 证据在 issue 数据之前（信任等级）
  });

  it("无相似结果时不输出空块", () => {
    const { user } = buildTriageMessages({ ...EVENT, similarIssues: [] });
    expect(user).not.toContain("<similar_issues>");
  });

  it("未传 similarIssues 时行为兼容（块不出现）", () => {
    const { user } = buildTriageMessages(EVENT);
    expect(user).not.toContain("<similar_issues>");
  });
});

describe("createSimilarIssuesSearch", () => {
  it("排除 case 自身并映射证据形状", async () => {
    const { search, store } = searchWith([
      { issueNumber: 14106, title: "NPE", bodyExcerpt: "堆栈", repliesExcerpt: "maintainer: fixed", score: 0.9 },
    ]);
    const hits = await search.search(EVENT);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.issueNumber).toBe(14106);
    expect(hits[0]?.snippet).toContain("maintainer: fixed");
    expect(store.lastQuery["excludeNumbers"]).toEqual([12345]);
  });

  it("检索失败抛出（降级责任在调用方）", async () => {
    const { search } = searchWith([], { fail: true });
    await expect(search.search(EVENT)).rejects.toThrow("embed 通道故障");
  });
});

describe("handleIssueEvent: 检索依赖接线", () => {
  function chatLlm(payload: { labels: string[]; rationale: string; confidence: number }): Llm {
    return createLlm({
      transport: createMockTransport({
        chat: () => ({
          content: JSON.stringify(payload),
          inputTokens: 100,
          outputTokens: 20,
          cachedInputTokens: 0,
        }),
      }),
    });
  }

  it("similarSearch 传入后：检索 tool 步留痕 + 分诊照常出结果", async () => {
    const llm = chatLlm({ labels: ["bug"], rationale: "堆栈明确", confidence: 0.9 });
    const { search } = searchWith([
      { issueNumber: 14106, title: "NPE", bodyExcerpt: "堆栈", repliesExcerpt: "", score: 0.9 },
    ]);
    const res = await handleIssueEvent(EVENT, { llm, similarSearch: search });
    expect(res.triage?.labels).toEqual(["bug"]);
    expect(res.steps).toHaveLength(2);
    expect(res.steps[0]?.kind).toBe("tool");
    expect(res.steps[0]?.toolSummary).toContain("similar-issues: 1 hits");
    expect(res.steps[1]?.kind).toBe("llm");
    expect(res.steps[1]?.seq).toBe(2);
  });

  it("检索失败降级：主链路照常出结果，留痕 0 hits", async () => {
    const llm = chatLlm({ labels: ["question"], rationale: "使用咨询", confidence: 0.8 });
    const { search } = searchWith([], { fail: true });
    const res = await handleIssueEvent(EVENT, { llm, similarSearch: search });
    expect(res.triage?.labels).toEqual(["question"]);
    expect(res.steps[0]?.toolSummary).toContain("0 hits");
  });

  it("不传 similarSearch 时 steps 形状不变（向后兼容）", async () => {
    const llm = chatLlm({ labels: ["bug"], rationale: "x", confidence: 0.9 });
    const res = await handleIssueEvent(EVENT, { llm });
    expect(res.steps).toHaveLength(1);
    expect(res.steps[0]?.kind).toBe("llm");
    expect(res.steps[0]?.promptVersion).toBe(TRIAGE_PROMPT_VERSION);
  });
});
