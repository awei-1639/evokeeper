import { exists, readJsonl } from "@/lib/data";
import { approveCandidate, rejectCandidate } from "./actions";

export const dynamic = "force-dynamic";

export default function ReleasesPage() {
  const releasesFile = "datasets/releases/releases.jsonl";
  const releases = exists(releasesFile) ? readJsonl(releasesFile) : [];
  const candidatesFile = "datasets/candidates/candidates.jsonl";
  const candidates = exists(candidatesFile) ? readJsonl(candidatesFile) : [];
  const proposed = candidates.filter((c) => c["status"] === "proposed");

  return (
    <>
      <h1>发布与回滚</h1>
      <p className="muted">
        发布前置（§8）：门禁五条 PASSED + 候选人工评审 approved + diff 非空；灰度 48h 观察后 promote / rollback。
        状态机实现：apps/worker/src/release.ts。
      </p>

      <h2>候选经验评审队列（{proposed.length} 条待评审）</h2>
      {candidates.length === 0 ? (
        <div className="empty">
          还没有候选经验——整理管线（W5 睡眠整理）从真实轨迹归纳产出门禁通过的候选后进入此队列。
          每条候选必须携带证据链（evidenceTraceIds），空证据链在管线内即被拒绝。
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>id</th>
              <th>类型</th>
              <th>模式</th>
              <th>内容</th>
              <th>证据链</th>
              <th>状态</th>
              <th>评审</th>
            </tr>
          </thead>
          <tbody>
            {candidates.map((c) => (
              <tr key={String(c["id"])}>
                <td>{String(c["id"])}</td>
                <td>
                  <span className="tag">{String(c["type"])}</span>
                </td>
                <td>{String(c["pattern"]).slice(0, 80)}</td>
                <td>{String(c["content"]).slice(0, 100)}…</td>
                <td>{(c["evidenceTraceIds"] as string[])?.length ?? 0} 条轨迹</td>
                <td>
                  <span className={`tag ${c["status"] === "approved" ? "ok" : c["status"] === "rejected" ? "bad" : ""}`}>
                    {String(c["status"])}
                  </span>
                </td>
                <td>
                  {c["status"] === "proposed" ? (
                    <form
                      style={{ display: "flex", gap: 6 }}
                      action={async (fd: FormData) => {
                        "use server";
                        const id = String(fd.get("id"));
                        const op = String(fd.get("op"));
                        if (op === "approve") await approveCandidate(id);
                        else await rejectCandidate(id);
                      }}
                    >
                      <input type="hidden" name="id" value={String(c["id"])} />
                      <button name="op" value="approve" className="tag ok" style={{ cursor: "pointer" }}>
                        采纳
                      </button>
                      <button name="op" value="reject" className="tag bad" style={{ cursor: "pointer" }}>
                        否决
                      </button>
                    </form>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>发布历史</h2>
      {releases.length === 0 ? (
        <div className="empty">
          还没有任何经验版本发布——符合预期：第一个候选要等真实流量产生轨迹 → 判别 → 整理出候选
          → 门禁五条全过之后才会出现（W6 里程碑）。
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
