/**
 * 记忆层四操作测试（W3 DoD：记忆四操作必须有单测全覆盖）
 *
 * 锁死 design.md §4 的判定契约：
 * ADD / UPDATE 优先于 ADD / DELETE 软删 / NONE 跳过；
 * 冲突消解：confidence 高者胜，并列取证据链更长；
 * validUntil 失效过滤 + (repo, kind, expectedSlice) 硬过滤 + Top-K。
 */
import { describe, expect, it } from "vitest";
import type { MemoryItem } from "./index";
import { MemoryLayer, InMemoryMemoryStore, JsonlMemoryStore, decideMemoryOp } from "./index";

const REPO = "alibaba/nacos";
const NOW = "2026-09-28T10:00:00.000Z";

function item(partial: Partial<MemoryItem>): MemoryItem {
  return {
    id: "mem-x",
    repo: REPO,
    kind: "semantic",
    content: "",
    evidenceRefs: [],
    confidence: 0.5,
    validUntil: null,
    expectedSlice: null,
    version: "1",
    createdAt: "2026-09-01T00:00:00.000Z",
    ...partial,
  };
}

describe("decideMemoryOp（纯函数四操作判定）", () => {
  it("新事实且无冲突 → ADD", () => {
    const d = decideMemoryOp(
      { repo: REPO, kind: "semantic", content: "Nacos 3.x 的 MCP 注册中心默认端口是 8848", confidence: 0.8, evidenceRefs: ["trace-1"] },
      []
    );
    expect(d.op).toBe("ADD");
  });

  it("无信息量（过短）→ NONE", () => {
    const d = decideMemoryOp(
      { repo: REPO, kind: "semantic", content: "太短", confidence: 0.9, evidenceRefs: [] },
      []
    );
    expect(d.op).toBe("NONE");
  });

  it("同实体更新：UPDATE 优先于 ADD，替换内容", () => {
    const existing = [item({ id: "mem-1", content: "Nacos 鉴权默认关闭，需要在 application.properties 开启 nacos.core.auth.enabled" , confidence: 0.6 })];
    const d = decideMemoryOp(
      {
        repo: REPO,
        kind: "semantic",
        content: "Nacos 鉴权默认关闭，开启方式是设置 nacos.core.auth.enabled=true 并配置密钥",
        confidence: 0.9,
        evidenceRefs: ["trace-2"],
      },
      existing
    );
    expect(d.op).toBe("UPDATE");
    expect(d.targetId).toBe("mem-1");
  });

  it("冲突消解：confidence 并列时证据链更长者胜", () => {
    const existing = [item({ id: "mem-1", content: "客户端注册实例用 registerInstance 接口，支持临时与持久节点", confidence: 0.7, evidenceRefs: ["t1"] })];
    const d = decideMemoryOp(
      {
        repo: REPO,
        kind: "semantic",
        content: "客户端注册实例用 registerInstance 接口，临时实例心跳保活",
        confidence: 0.7,
        evidenceRefs: ["t2", "t3"],
      },
      existing
    );
    expect(d.op).toBe("UPDATE");
  });

  it("在位记忆 confidence 更高 → NONE 跳过（不降级覆盖）", () => {
    const existing = [item({ id: "mem-1", content: "集群同步走 Distro 协议，全量与增量两个阶段", confidence: 0.95, evidenceRefs: ["t1", "t2"] })];
    const d = decideMemoryOp(
      {
        repo: REPO,
        kind: "semantic",
        content: "集群同步走 Distro 协议进行数据同步",
        confidence: 0.5,
        evidenceRefs: ["t9"],
      },
      existing
    );
    expect(d.op).toBe("NONE");
  });

  it("invalidates + 同实体 → DELETE 软删", () => {
    const existing = [item({ id: "mem-1", content: "Nacos 2.x 的配置灰度发布支持 beta 配置", confidence: 0.8, evidenceRefs: ["t1"] })];
    const d = decideMemoryOp(
      {
        repo: REPO,
        kind: "semantic",
        content: "Nacos 2.x 的配置灰度发布 beta 配置功能已在 2.3 版本移除",
        confidence: 0.9,
        evidenceRefs: ["t2"],
        invalidates: true,
      },
      existing
    );
    expect(d.op).toBe("DELETE");
    expect(d.targetId).toBe("mem-1");
  });

  it("跨 repo / 跨 kind 不参与冲突判定", () => {
    const existing = [
      item({ id: "mem-1", repo: "other/repo", content: "客户端注册实例用 registerInstance 接口完成服务注册", confidence: 0.99 }),
      item({ id: "mem-2", kind: "preference", content: "客户端注册实例用 registerInstance 接口完成服务注册", confidence: 0.99 }),
    ];
    const d = decideMemoryOp(
      { repo: REPO, kind: "semantic", content: "客户端注册实例用 registerInstance 接口完成服务注册", confidence: 0.5, evidenceRefs: [] },
      existing
    );
    expect(d.op).toBe("ADD");
  });
});

describe("MemoryLayer 写路径", () => {
  it("ADD → UPDATE 链：内容替换、证据链追加去重、版本递增、confidence 取高", async () => {
    const layer = new MemoryLayer();
    const add = await layer.write({
      repo: REPO,
      kind: "semantic",
      content: "Nacos 控制台默认端口 8080，可通过 server.port 配置",
      confidence: 0.6,
      evidenceRefs: ["trace-1"],
      now: NOW,
    });
    expect(add.op).toBe("ADD");
    expect(add.itemId).toBe("mem-1");

    const upd = await layer.write({
      repo: REPO,
      kind: "semantic",
      content: "Nacos 控制台默认端口 8080；3.x 控制台独立端口 8080 与主端口分离",
      confidence: 0.85,
      evidenceRefs: ["trace-2", "trace-1"],
      now: NOW,
    });
    expect(upd.op).toBe("UPDATE");
    expect(upd.itemId).toBe("mem-1");

    const got = await layer.query({ repo: REPO, kind: "semantic" });
    expect(got).toHaveLength(1);
    expect(got[0]?.version).toBe("2");
    expect(got[0]?.confidence).toBe(0.85);
    expect(got[0]?.evidenceRefs).toEqual(["trace-1", "trace-2"]);
  });

  it("DELETE 软删：置 validUntil 后 query 不再返回，但记录仍在（审计链）", async () => {
    const store = new InMemoryMemoryStore();
    const layer = new MemoryLayer({ store });
    await layer.write({
      repo: REPO,
      kind: "semantic",
      content: "Nacos 2.x 支持 beta 灰度配置发布方式",
      confidence: 0.8,
      evidenceRefs: ["trace-1"],
    });
    const del = await layer.write({
      repo: REPO,
      kind: "semantic",
      content: "Nacos 2.x 的 beta 灰度配置已在后续版本移除，改用正式灰度规则",
      confidence: 0.9,
      evidenceRefs: ["trace-2"],
      invalidates: true,
      now: NOW,
    });
    expect(del.op).toBe("DELETE");

    const visible = await layer.query({ repo: REPO, now: NOW });
    expect(visible).toHaveLength(0);
    // 软删不是物理删除：审计链保留
    expect(store.size).toBe(1);
    const all = await store.listByRepo(REPO);
    expect(all[0]?.validUntil).toBe(NOW);
  });

  it("NONE 时存储不变", async () => {
    const store = new InMemoryMemoryStore();
    const layer = new MemoryLayer({ store });
    await layer.write({
      repo: REPO,
      kind: "semantic",
      content: "Distro 协议负责集群数据同步的全量与增量阶段",
      confidence: 0.95,
      evidenceRefs: ["t1", "t2", "t3"],
    });
    const skip = await layer.write({
      repo: REPO,
      kind: "semantic",
      content: "Distro 协议负责集群同步",
      confidence: 0.5,
      evidenceRefs: ["t9"],
    });
    expect(skip.op).toBe("NONE");
    expect(store.size).toBe(1);
  });
});

describe("MemoryLayer 读路径", () => {
  const layer = new MemoryLayer({ genId: (() => { let n = 0; return () => `mem-${++n}`; })() });

  it("切片硬过滤 + 失效过滤 + confidence 排序 + Top-K", async () => {
    const rows: Array<[string, "semantic" | "preference", string | null, string, number, string | null]> = [
      ["mem-1", "semantic", "labels=bug & topic=build-error", "构建失败时优先检查 JDK 版本与编译插件兼容性", 0.9, null],
      ["mem-2", "semantic", "labels=bug & topic=build-error", "客户端注册失败先确认网络连通性与端口配置", 0.7, null],
      ["mem-3", "semantic", "labels=question & topic=mcp", "MCP 工具注册问题先查 swagger 暴露路径", 0.95, null],
      ["mem-4", "preference", "labels=bug & topic=build-error", "维护者偏好先看完整日志再下结论", 0.6, null],
      ["mem-5", "semantic", "labels=bug & topic=build-error", "旧版本灰度配置走 beta 入口操作", 0.99, "2026-09-20"],
      ["mem-6", "semantic", "labels=bug & topic=build-error", "配置推送异常时优先核对 dataId 与分组", 0.8, null],
    ];
    for (const [id, kind, slice, content, confidence, validUntil] of rows) {
      const r = await layer.write({
        id,
        repo: REPO,
        kind,
        content,
        confidence,
        evidenceRefs: ["t"],
        expectedSlice: slice,
        validUntil,
      });
      expect(r.op).toBe("ADD");
    }

    const hits = await layer.query({
      repo: REPO,
      kind: "semantic",
      expectedSlice: "labels=bug & topic=build-error",
      limit: 2,
      now: NOW,
    });
    // mem-5 已失效（validUntil 2026-09-20 < now），mem-3 切片不符，mem-4 kind 不符
    expect(hits.map((h) => h.id)).toEqual(["mem-1", "mem-6"]);
  });

  it("人工修订入口递增版本", async () => {
    const updated = await layer.update("mem-1", { confidence: 0.93 });
    expect(updated.version).toBe("2");
    expect(updated.confidence).toBe(0.93);
  });
});

describe("JsonlMemoryStore（持久化）", () => {
  it("跨实例恢复 + 软删状态保留", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "evokeeper-mem-"));
    const file = join(dir, "memory.jsonl");

    const layer1 = new MemoryLayer({ store: new JsonlMemoryStore(file) });
    await layer1.write({
      id: "mem-1",
      repo: REPO,
      kind: "semantic",
      content: "Nacos 客户端注册实例用 registerInstance 接口，支持临时与持久节点",
      confidence: 0.8,
      evidenceRefs: ["trace-1"],
    });
    await layer1.write({
      id: "mem-2",
      repo: REPO,
      kind: "semantic",
      content: "Nacos 2.x 的 beta 灰度配置功能已在后续版本移除",
      confidence: 0.9,
      evidenceRefs: ["trace-2"],
      invalidates: false,
    });
    // 软删 mem-2 的既有记录（用 update 不行——用直写模拟 judge 后失效）
    const store1 = new JsonlMemoryStore(file);
    await store1.softDelete("mem-2", "2026-09-28T00:00:00.000Z");

    // 新实例（模拟重启）读回
    const store2 = new JsonlMemoryStore(file);
    const layer2 = new MemoryLayer({ store: store2 });
    const visible = await layer2.query({ repo: REPO, now: "2026-09-29T00:00:00.000Z" });
    expect(visible.map((v) => v.id)).toEqual(["mem-1"]);
    const all = await store2.listByRepo(REPO);
    expect(all).toHaveLength(2); // 软删保留审计链
  });
});
