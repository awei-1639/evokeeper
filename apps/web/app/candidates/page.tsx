import { exists, readJsonl } from "@/lib/data";

export const dynamic = "force-dynamic";

/**
 * 候选经验评审队列（W6 人工评审入口）
 *
 * 数据源：datasets/candidates/candidates.jsonl（睡眠整理产出，status=proposed）。
 * R1 红线：任何候选不经人工评审 + eval:gate 门禁不得生效——本页只读，
 * 评审动作（approve/reject）走命令行 / releases 流程，页面保持零写权限。
 */

const STATUS_STYLES: Record<string, string> = {
  proposed: "tag",
  evaluating: "tag ok",
  approved: "tag ok",
  rejected: "tag bad",
  released: "tag ok",
};

interface CandidateView {
  id: string;
  type: string;
  repo: string;
  pattern: string;
  content: string;
  expectedSlice: string;
  evidenceTraceIds: string[];
  consolidationJobId: string;
  status: string;
  createdAt: string;
}

export default function CandidatesPage() {
  const candidates: CandidateView[] = exists("datasets/candidates/candidates.jsonl")
    ? readJsonl("datasets/candidates/candidates.jsonl").map((row) => ({
        id: String(row["id"] ?? ""),
        type: String(row["type"] ?? ""),
        repo: String(row["repo"] ?? ""),
        pattern: String(row["pattern"] ?? ""),
        content: String(row["content"] ?? ""),
        expectedSlice: String(row["expectedSlice"] ?? ""),
        evidenceTraceIds: (row["evidenceTraceIds"] ?? []) as string[],
        consolidationJobId: String(row["consolidationJobId"] ?? ""),
        status: String(row["status"] ?? "proposed"),
        createdAt: String(row["createdAt"] ?? ""),
      }))
    : [];

  const byStatus = new Map<string, number>();
  for (const c of candidates) byStatus.set(c.status, (byStatus.get(c.status) ?? 0) + 1);

  return (
    <>
      <h1>候选经验</h1>
      <p className="muted">
        睡眠整理产出（聚类 → LLM 归纳 → 带证据链候选）。R1：候选必须经人工评审 + eval:gate
        门禁通过才可发布；本页只读。状态分布：
        {[...byStatus.entries()].map(([s, n]) => `${s} ${n}`).join(" · ") || "无"}
      </p>

      {candidates.length === 0 ? (
        <div className="empty">
          暂无候选。原料路径：scan:daily（真实信号）或 rehearse-consolidate（演练）→ 睡眠整理。
        </div>
      ) : (
        candidates.map((c) => (
          <div
            key={c.id}
            style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "12px 16px", marginBottom: 12 }}
          >
            <p style={{ margin: "0 0 6px" }}>
              <span className={STATUS_STYLES[c.status] ?? "tag"}>{c.status}</span>{" "}
              <strong>[{c.type}]</strong> {c.pattern}
            </p>
            <p className="muted" style={{ margin: "0 0 6px" }}>
              适用切片 {c.expectedSlice} · 仓库 {c.repo} · 证据 {c.evidenceTraceIds.length} 条 · 产出 job{" "}
              <code>{c.consolidationJobId.slice(0, 13)}</code> · {c.createdAt.slice(0, 19).replace("T", " ")}
            </p>
            <details>
              <summary style={{ cursor: "pointer", listStyle: "revert" }}>经验正文</summary>
              <div style={{ whiteSpace: "pre-wrap", padding: "6px 0" }}>{c.content}</div>
            </details>
            <details>
              <summary style={{ cursor: "pointer", listStyle: "revert" }}>证据链（{c.evidenceTraceIds.length} 条轨迹）</summary>
              <ul className="muted" style={{ margin: "6px 0" }}>
                {c.evidenceTraceIds.map((id) => (
                  <li key={id}>
                    <code>{id}</code>
                  </li>
                ))}
              </ul>
            </details>
          </div>
        ))
      )}
    </>
  );
}
