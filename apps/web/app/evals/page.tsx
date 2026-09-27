import { listJsonFiles, readJson, toEvalRunView, type EvalRunView, type Json } from "@/lib/data";

export const dynamic = "force-dynamic";

export default function EvalsPage() {
  const evalViews: EvalRunView[] = listJsonFiles("datasets/eval")
    .map((f) => {
      const raw = readJson(f);
      return raw ? toEvalRunView(f, raw) : null;
    })
    .filter((v): v is EvalRunView => v !== null);

  const pilots = listJsonFiles("datasets/pilot")
    .map((f) => ({ file: f, raw: readJson(f) }))
    .filter((p): p is { file: string; raw: Json } => p.raw !== null);

  return (
    <>
      <h1>评测报告</h1>
      <p className="muted">
        数据源：datasets/eval（eval:run 产出的 EvalRun，门禁输入）与 datasets/pilot（pilot 与基线报告）。
        禁止跨 datasetVersion 比较指标（§7.1）。
      </p>

      <h2>EvalRun（门禁输入）</h2>
      {evalViews.length === 0 ? (
        <div className="empty">
          暂无 EvalRun。运行：<code>pnpm eval:run -- --tag=baseline --split=dev --ds=v1-draft-n300</code>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>run id</th>
              <th>split</th>
              <th>dataset</th>
              <th>模型</th>
              <th>准确率</th>
              <th>宏 F1</th>
              <th>CI95</th>
              <th>成本/条</th>
              <th>p95</th>
            </tr>
          </thead>
          <tbody>
            {evalViews.map((v) => (
              <tr key={v.file}>
                <td>{v.id}</td>
                <td>{v.split}</td>
                <td>{v.datasetVersion}</td>
                <td>
                  {v.model}
                  <span className="tag" style={{ marginLeft: 6 }}>
                    {v.modelConfigVersion}
                  </span>
                </td>
                <td>{v.accuracyPct.toFixed(1)}%</td>
                <td>{v.macroF1.toFixed(3)}</td>
                <td>{v.ciLowerPct !== null ? `[${v.ciLowerPct.toFixed(1)}, ${v.ciUpperPct?.toFixed(1)}]pt` : "—"}</td>
                <td>¥{v.costPerIssue.toFixed(5)}</td>
                <td>{v.p95LatencyMs}ms</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Pilot / 基线 / 对抗检查（历史报告）</h2>
      <table>
        <thead>
          <tr>
            <th>文件</th>
            <th>n</th>
            <th>关键数字</th>
          </tr>
        </thead>
        <tbody>
          {pilots.map(({ file, raw }) => {
            const n = Number(raw["n"] ?? raw["total"] ?? 0);
            const acc = raw["accuracy"] as number | undefined;
            const pass = raw["pass"] as number | undefined;
            const totalCost = raw["totalCost"] as number | undefined;
            const key =
              acc !== undefined
                ? `accuracy ${(acc * 100).toFixed(1)}%`
                : pass !== undefined
                  ? `防线通过 ${pass}/${n}`
                  : raw["promptVersion"] === undefined && raw["answerQuality"] !== undefined
                    ? "-"
                    : "—";
            return (
              <tr key={file}>
                <td>{file.replace("datasets/pilot/", "")}</td>
                <td>{n}</td>
                <td>{key}{totalCost !== undefined ? ` · ¥${totalCost.toFixed(4)}` : ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
