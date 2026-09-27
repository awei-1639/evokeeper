import { exists, readJsonl } from "@/lib/data";

export const dynamic = "force-dynamic";

interface TraceView {
  id: string;
  repo: string;
  issueNumber: number;
  agentVersion: string;
  totalCost: number;
  totalTokens: number;
  startedAt: string;
  labels: string;
  escalated: boolean;
}

function loadTraces(): TraceView[] {
  const file = "datasets/traces/traces.jsonl";
  if (!exists(file)) return [];
  return readJsonl(file)
    .map((row): TraceView => {
      const actions = (row["finalActions"] ?? []) as Array<Record<string, unknown>>;
      const labels = actions
        .flatMap((a) => (a["kind"] === "addLabels" ? (a["labels"] as string[]) : []))
        .join(",");
      return {
        id: String(row["id"] ?? ""),
        repo: String(row["repo"] ?? ""),
        issueNumber: Number(row["issueNumber"] ?? 0),
        agentVersion: String(row["agentVersion"] ?? ""),
        totalCost: Number(row["totalCost"] ?? 0),
        totalTokens: Number(row["totalTokens"] ?? 0),
        startedAt: String(row["startedAt"] ?? ""),
        labels: labels || "—",
        escalated: actions.some((a) => a["kind"] === "escalate"),
      };
    })
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export default function TracesPage() {
  const traces = loadTraces();

  return (
    <>
      <h1>轨迹查看器</h1>
      <p className="muted">
        数据源：datasets/traces/traces.jsonl（webhook 服务传入 JsonlTraceStore 后自动落库，trace id = GitHub delivery id；R3：成功与失败都落库）。
      </p>

      {traces.length === 0 ? (
        <div className="empty">
          还没有落库轨迹。两条路径：
          <br />
          ① 真实流量：GitHub App 凭据就绪后，webhook 服务传入 JsonlTraceStore 即自动落库；
          <br />
          ② 离线评测：eval:run 产出的是 EvalRun（见评测报告页），其 perCase 可回溯每条判定。
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>trace id</th>
              <th>issue</th>
              <th>agent 版本</th>
              <th>标签</th>
              <th>成本</th>
              <th>tokens</th>
              <th>开始时间</th>
              <th>转人工</th>
            </tr>
          </thead>
          <tbody>
            {traces.map((t) => (
              <tr key={t.id}>
                <td>{t.id}</td>
                <td>
                  {t.repo}#{t.issueNumber}
                </td>
                <td>{t.agentVersion}</td>
                <td>{t.labels}</td>
                <td>¥{t.totalCost.toFixed(4)}</td>
                <td>{t.totalTokens}</td>
                <td>{t.startedAt.slice(0, 19).replace("T", " ")}</td>
                <td>{t.escalated ? <span className="tag bad">escalate</span> : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
