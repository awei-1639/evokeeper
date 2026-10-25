import { Fragment } from "react";
import { exists, readJsonl } from "@/lib/data";

export const dynamic = "force-dynamic";

/** 轨迹来源：线上 = webhook 真实投递；重放 = 重放器冷启动产物；历史 = 早期评测引导轨迹 */
type Source = "线上" | "重放" | "历史";

interface StepView {
  seq: number;
  kind: string;
  model: string;
  promptVersion: string;
  inputTokens: number;
  outputTokens: number;
  costAmount: number;
  durationMs: number;
  toolSummary: string;
}

interface TraceView {
  id: string;
  repo: string;
  issueNumber: number;
  source: Source;
  agentVersion: string;
  totalCost: number;
  totalTokens: number;
  startedAt: string;
  labels: string;
  escalated: boolean;
  steps: StepView[];
  commentExcerpt: string;
}

function loadTrace(file: string, source: Source): TraceView[] {
  if (!exists(file)) return [];
  return readJsonl(file).map((row): TraceView => {
    const actions = (row["finalActions"] ?? []) as Array<Record<string, unknown>>;
    const labels = actions
      .flatMap((a) => (a["kind"] === "addLabels" ? (a["labels"] as string[]) : []))
      .join(",");
    const comment = actions.find((a) => a["kind"] === "comment");
    const steps = ((row["steps"] ?? []) as Array<Record<string, unknown>>).map(
      (s, i): StepView => ({
        seq: Number(s["seq"] ?? i + 1),
        kind: String(s["kind"] ?? ""),
        model: String(s["model"] ?? ""),
        promptVersion: String(s["promptVersion"] ?? "—"),
        inputTokens: Number(s["inputTokens"] ?? 0),
        outputTokens: Number(s["outputTokens"] ?? 0),
        costAmount: Number(s["costAmount"] ?? 0),
        durationMs: Number(s["durationMs"] ?? 0),
        toolSummary: String(s["toolSummary"] ?? ""),
      })
    );
    return {
      id: String(row["id"] ?? ""),
      repo: String(row["repo"] ?? ""),
      issueNumber: Number(row["issueNumber"] ?? 0),
      source,
      agentVersion: String(row["agentVersion"] ?? ""),
      totalCost: Number(row["totalCost"] ?? 0),
      totalTokens: Number(row["totalTokens"] ?? 0),
      startedAt: String(row["startedAt"] ?? ""),
      labels: labels || "—",
      escalated: actions.some((a) => a["kind"] === "escalate"),
      steps,
      commentExcerpt:
        comment && typeof comment["body"] === "string"
          ? (comment["body"] as string).replace(/\s+/g, " ").slice(0, 160)
          : "",
    };
  });
}

const SOURCE_STYLES: Record<Source, string> = {
  线上: "tag ok",
  重放: "tag",
  历史: "muted",
};

export default async function TracesPage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string }>;
}) {
  const { source: sourceParam } = await searchParams;
  const all = [
    ...loadTrace("datasets/traces/traces.jsonl", "历史").filter((t) => t.repo === "awei-1639/evokeeper"),
    ...loadTrace("datasets/traces/traces.jsonl", "历史").filter((t) => t.repo !== "awei-1639/evokeeper"),
    ...loadTrace("datasets/traces/replay-traces.jsonl", "重放"),
  ];
  // 线上轨迹与历史轨迹同库，判别依据 = 目标仓库（Bot 只装在 awei-1639/evokeeper）
  for (const t of all) if (t.repo === "awei-1639/evokeeper" && t.source === "历史") t.source = "线上";

  const counts = {
    线上: all.filter((t) => t.source === "线上").length,
    重放: all.filter((t) => t.source === "重放").length,
    历史: all.filter((t) => t.source === "历史").length,
  };
  const filter = sourceParam && sourceParam in counts ? (sourceParam as Source) : null;
  const traces = (filter ? all.filter((t) => t.source === filter) : all)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, filter ? 500 : 300);
  const totalCost = traces.reduce((a, t) => a + t.totalCost, 0);

  return (
    <>
      <h1>轨迹查看器</h1>
      <p className="muted">
        R3：每次处理的每一步（模型/提示词版本/tokens/成本/耗时）都留痕。展开行查看 TraceStep 明细与动作内容。
      </p>
      <p>
        {(["线上", "重放", "历史"] as Source[]).map((s, i) => (
          <span key={s}>
            {i > 0 && " · "}
            {filter === s ? (
              <strong>
                {s} {counts[s]}
              </strong>
            ) : (
              <a href={`/traces?source=${encodeURIComponent(s)}`} style={{ color: "var(--accent)" }}>
                {s} {counts[s]}
              </a>
            )}
          </span>
        ))}
        {filter && (
          <>
            {" · "}
            <a href="/traces" style={{ color: "var(--accent)" }}>
              全部
            </a>
          </>
        )}
        {" · "}
        <span className="muted">本页合计成本 ¥{totalCost.toFixed(4)}</span>
      </p>

      {traces.length === 0 ? (
        <div className="empty">该来源暂无轨迹。</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>trace id / 明细</th>
              <th>issue</th>
              <th>来源</th>
              <th>标签</th>
              <th>成本</th>
              <th>tokens</th>
              <th>开始时间</th>
              <th>转人工</th>
            </tr>
          </thead>
          <tbody>
            {traces.map((t) => (
              <Fragment key={t.id}>
                <tr>
                  <td>
                    <details>
                      <summary style={{ cursor: "pointer", listStyle: "revert" }}>
                        <code>{t.id.slice(0, 24)}</code>
                      </summary>
                      <div style={{ padding: "8px 0" }}>
                        <table style={{ margin: 0 }}>
                          <thead>
                            <tr>
                              <th>#</th>
                              <th>类型</th>
                              <th>模型</th>
                              <th>提示词</th>
                              <th>入 tokens</th>
                              <th>出 tokens</th>
                              <th>成本</th>
                              <th>耗时</th>
                            </tr>
                          </thead>
                          <tbody>
                            {t.steps.map((s) => (
                              <tr key={s.seq}>
                                <td>{s.seq}</td>
                                <td>
                                  {s.kind}
                                  {s.toolSummary ? (
                                    <span className="muted">（{s.toolSummary}）</span>
                                  ) : null}
                                </td>
                                <td>{s.model}</td>
                                <td>{s.promptVersion}</td>
                                <td>{s.inputTokens}</td>
                                <td>{s.outputTokens}</td>
                                <td>¥{s.costAmount.toFixed(6)}</td>
                                <td>{s.durationMs}ms</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {t.commentExcerpt && (
                          <p className="muted" style={{ margin: "6px 0 0" }}>
                            评论动作：{t.commentExcerpt}…
                          </p>
                        )}
                        <p className="muted" style={{ margin: "4px 0 0" }}>
                          agent {t.agentVersion}
                        </p>
                      </div>
                    </details>
                  </td>
                  <td>
                    <a
                      href={`https://github.com/${t.repo}/issues/${t.issueNumber}`}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: "var(--accent)" }}
                    >
                      {t.repo}#{t.issueNumber}
                    </a>
                  </td>
                  <td>
                    <span className={SOURCE_STYLES[t.source]}>{t.source}</span>
                  </td>
                  <td>{t.labels}</td>
                  <td>¥{t.totalCost.toFixed(4)}</td>
                  <td>{t.totalTokens}</td>
                  <td>{t.startedAt.slice(0, 19).replace("T", " ")}</td>
                  <td>{t.escalated ? <span className="tag bad">escalate</span> : "—"}</td>
                </tr>
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
