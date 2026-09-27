/**
 * 检索层行为测试：分词、BM25 排序、语料加载、证据块装配
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BM25Index, buildEvidence, loadCorpusFromJsonl, tokenize } from "./retrieval";

describe("tokenize", () => {
  it("ASCII 词保留连字符与版本号，小写归一", () => {
    expect(tokenize("Nacos-Client 2.5.1 ERROR")).toContain("nacos-client");
    expect(tokenize("Nacos-Client 2.5.1 ERROR")).toContain("2.5.1");
    expect(tokenize("Nacos-Client 2.5.1 ERROR")).toContain("error");
  });

  it("CJK 产出 bigram", () => {
    expect(tokenize("服务注册失败")).toEqual(["服务", "务注", "注册", "册失", "失败"]);
  });
});

describe("BM25Index", () => {
  const corpus = [
    {
      issueNumber: 1,
      title: "集群同步报错 gRPC 消息超过 10M",
      body: "gRPC message exceeds maximum size，Distro 同步失败",
      replies: [{ author: "KomachiSion", body: "调大 nacos.remote.client.grpc.maxinbound.message.size" }],
    },
    {
      issueNumber: 2,
      title: "控制台中文乱码",
      body: "页面显示乱码，编码问题",
      replies: [],
    },
    {
      issueNumber: 3,
      title: "希望支持导出 CSV",
      body: "export 命令希望支持 --format=csv",
      replies: [],
    },
  ];

  it("命中词最多的文档排第一，无命中文档被过滤", () => {
    const idx = new BM25Index(corpus);
    const hits = idx.search("gRPC 消息超过 10M 怎么调", 5);
    expect(hits[0]?.doc.issueNumber).toBe(1);
    expect(hits.map((h) => h.doc.issueNumber)).not.toContain(3);
  });

  it("maxTokens 版本号检索可命中对应 issue", () => {
    const idx = new BM25Index(corpus);
    const hits = idx.search("maxinbound.message.size 配置", 1);
    expect(hits[0]?.doc.issueNumber).toBe(1);
  });

  it("空语料返回空结果不抛错", () => {
    expect(new BM25Index([]).search("任意", 3)).toEqual([]);
  });
});

describe("loadCorpusFromJsonl", () => {
  it("跳过重复 issue 与抓取失败占位回复", () => {
    const dir = mkdtempSync(join(tmpdir(), "evokeeper-corpus-"));
    const file = join(dir, "corpus.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({
          issue_number: 1,
          title: "t1",
          body_excerpt: "b1",
          maintainer_replies: [{ author: "m", body_excerpt: "r1" }],
        }),
        JSON.stringify({
          issue_number: 1,
          title: "重复",
          body_excerpt: "dup",
          maintainer_replies: [],
        }),
        JSON.stringify({
          issue_number: 2,
          title: "t2",
          body_excerpt: "b2",
          maintainer_replies: [{ author: "fetch-error", body_excerpt: "GitHub API 401" }],
        }),
      ].join("\n"),
      "utf8"
    );
    const docs = loadCorpusFromJsonl(file);
    expect(docs).toHaveLength(2);
    expect(docs[0]?.replies).toEqual([{ author: "m", body: "r1" }]);
    expect(docs.find((d) => d.issueNumber === 2)?.replies).toEqual([]);
  });
});

describe("buildEvidence", () => {
  it("正文截断 + 回复带作者前缀", () => {
    const evidence = buildEvidence([
      {
        doc: {
          issueNumber: 7,
          title: "长正文标题",
          body: "x".repeat(500),
          replies: [{ author: "komachi", body: "y".repeat(400) }],
        },
        score: 1,
      },
    ]);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.issueNumber).toBe(7);
    expect(evidence[0]?.snippet.length).toBeLessThanOrEqual(300 + 1 + "komachi: ".length + 260);
    expect(evidence[0]?.snippet).toContain("komachi: ");
  });
});
