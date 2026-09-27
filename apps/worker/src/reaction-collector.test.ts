/**
 * 反应信号采集器测试（信号映射规则 v1，provisional）
 *
 * 锁死：处理时刻之后才算反应；Bot 自身动作排除；
 * reopened/改标签 = 显式失败信号；作者感谢 = success；
 * 孤立追问不成信号（≥2 才判 unsatisfied）；维护者纠正评论需命中纠正线索。
 */
import { describe, expect, it } from "vitest";
import { mapToSignals, type GithubEvent, type IssueSnapshot, type ProcessedIssue } from "./reaction-collector";

const ISSUE: IssueSnapshot = { state: "open", author: "alice", labels: ["bug"], updatedAt: "2026-09-28T00:00:00.000Z" };
const PROCESSED: ProcessedIssue = {
  repo: "alibaba/nacos",
  issueNumber: 1,
  processedAt: "2026-09-20T00:00:00.000Z",
  botLogin: "evokeeper-bot",
};

function ev(partial: Partial<GithubEvent>): GithubEvent {
  return {
    event: "commented",
    actor: "alice",
    authorAssociation: "NONE",
    createdAt: "2026-09-25T00:00:00.000Z",
    ...partial,
  };
}

describe("mapToSignals", () => {
  it("reopened → issue_reopened", () => {
    const s = mapToSignals(ISSUE, [ev({ event: "reopened", actor: "alice" })], PROCESSED);
    expect(s.map((x) => x.kind)).toEqual(["issue_reopened"]);
  });

  it("维护者改标签 → maintainer_relabel；Bot 自己打标签不算", () => {
    const s = mapToSignals(
      ISSUE,
      [
        ev({ event: "labeled", actor: "komachi", label: "kind/bug" }),
        ev({ event: "unlabeled", actor: "evokeeper-bot", label: "question" }),
      ],
      PROCESSED
    );
    expect(s).toHaveLength(1);
    expect(s[0]?.kind).toBe("maintainer_relabel");
  });

  it("作者关闭 → issue_closed_by_author；他人关闭不算", () => {
    const byAuthor = mapToSignals(ISSUE, [ev({ event: "closed", actor: "alice" })], PROCESSED);
    expect(byAuthor.map((x) => x.kind)).toEqual(["issue_closed_by_author"]);
    const byOther = mapToSignals(ISSUE, [ev({ event: "closed", actor: "komachi" })], PROCESSED);
    expect(byOther).toHaveLength(0);
  });

  it("作者感谢 → author_thanks", () => {
    const s = mapToSignals(ISSUE, [ev({ body: "太感谢了，解决了我的问题" })], PROCESSED);
    expect(s.map((x) => x.kind)).toEqual(["author_thanks"]);
  });

  it("孤立追问不成信号；追问 ≥2 → author_followup_unsatisfied", () => {
    const single = mapToSignals(ISSUE, [ev({ body: "还是有问题，看下日志" })], PROCESSED);
    expect(single).toHaveLength(0);

    const twice = mapToSignals(
      ISSUE,
      [ev({ body: "还是有问题", createdAt: "2026-09-24T00:00:00.000Z" }), ev({ body: "依然复现", createdAt: "2026-09-26T00:00:00.000Z" })],
      PROCESSED
    );
    expect(twice.filter((x) => x.kind === "author_followup_unsatisfied")).toHaveLength(2);
  });

  it("维护者纠正评论 → maintainer_correction_comment；普通维护者评论不算", () => {
    const correcting = mapToSignals(
      ISSUE,
      [ev({ actor: "komachi", authorAssociation: "MEMBER", body: "你的理解其实不对，这个配置是客户端侧的" })],
      PROCESSED
    );
    expect(correcting.map((x) => x.kind)).toEqual(["maintainer_correction_comment"]);

    const neutral = mapToSignals(
      ISSUE,
      [ev({ actor: "komachi", authorAssociation: "MEMBER", body: "收到，我们看一下" })],
      PROCESSED
    );
    expect(neutral).toHaveLength(0);
  });

  it("处理时刻之前的事件与 Bot 自身动作被排除", () => {
    const s = mapToSignals(
      ISSUE,
      [
        ev({ event: "reopened", actor: "alice", createdAt: "2026-09-19T00:00:00.000Z" }), // 处理前
        ev({ event: "reopened", actor: "evokeeper-bot", createdAt: "2026-09-26T00:00:00.000Z" }), // Bot 自身
      ],
      PROCESSED
    );
    expect(s).toHaveLength(0);
  });

  it("与真实判别器联动：reopened 信号判 failure", async () => {
    const { judgeTrace } = await import("./judge");
    const s = mapToSignals(ISSUE, [ev({ event: "reopened", actor: "alice" })], PROCESSED);
    const judged = judgeTrace(
      {
        id: "trace-1",
        repo: "alibaba/nacos",
        issueNumber: 1,
        agentVersion: "0.1.0",
        issueExcerpt: null,
        steps: [],
        finalActions: [],
        totalCost: 0,
        totalTokens: 0,
        startedAt: "2026-09-20T00:00:00.000Z",
        finishedAt: "2026-09-20T00:00:05.000Z",
      },
      s,
      { now: "2026-09-28T00:00:00.000Z" }
    );
    expect(judged.verdict).toBe("failure");
  });
});
