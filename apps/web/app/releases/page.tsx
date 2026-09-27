import { exists, readJsonl } from "@/lib/data";

export const dynamic = "force-dynamic";

export default function ReleasesPage() {
  const file = "datasets/releases/releases.jsonl";
  const releases = exists(file)
    ? readJsonl(file).sort((a, b) => String(b["releasedAt"]).localeCompare(String(a["releasedAt"])))
    : [];

  return (
    <>
      <h1>发布与回滚</h1>
      <p className="muted">
        数据源：datasets/releases/releases.jsonl（release 状态机产出，§8）。发布前置：门禁五条全过 + 候选人工评审 approved +
        diff 非空；灰度 48h 观察后 promote / rollback。
      </p>

      {releases.length === 0 ? (
        <div className="empty">
          还没有任何经验版本发布——这是符合预期的：第一个候选要等真实流量产生轨迹
          → 判别 → 整理出候选 → 门禁五条全过之后才会出现（W6 里程碑）。
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>版本</th>
              <th>候选</th>
              <th>状态</th>
              <th>灰度范围</th>
              <th>回滚自</th>
              <th>发布时间</th>
            </tr>
          </thead>
          <tbody>
            {releases.map((r) => {
              const status = String(r["status"]);
              return (
                <tr key={String(r["version"])}>
                  <td>{String(r["version"])}</td>
                  <td>{String(r["candidateId"])}</td>
                  <td>
                    <span className={`tag ${status === "rolled_back" ? "bad" : status === "full" ? "ok" : ""}`}>
                      {status}
                    </span>
                  </td>
                  <td>{String(r["canaryScope"] ?? "—")}</td>
                  <td>{r["rollbackOf"] ? String(r["rollbackOf"]) : "—"}</td>
                  <td>{String(r["releasedAt"]).slice(0, 19).replace("T", " ")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}
