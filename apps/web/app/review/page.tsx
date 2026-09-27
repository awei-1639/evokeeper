import { readJson } from "@/lib/data";

export const dynamic = "force-dynamic";

interface ReviewItem {
  issue_number: number;
  id: string;
  review: string;
  resolved?: boolean;
  resolution?: string | null;
}

export default function ReviewPage() {
  const reviews = (readJson<ReviewItem[]>("datasets/ai-annotation/round1/reviews.json") ?? []) as ReviewItem[];
  const pending = reviews.filter((r) => !r.resolved);
  const resolved = reviews.filter((r) => r.resolved);

  return (
    <>
      <h1>仲裁清单（AI 标注 review 项）</h1>
      <p className="muted">
        数据源：datasets/ai-annotation/round1/reviews.json。裁决方式：核对 issue 原文与维护者回复，修改
        datasets/drafts/alibaba_nacos.jsonl 中对应记录的 labels_gold / triage_rationale（R1 地基，改动须留痕）。
      </p>

      <h2>待仲裁（{pending.length}）</h2>
      {pending.length === 0 ? (
        <div className="empty">全部已裁决。</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>id</th>
              <th>issue</th>
              <th>review 原因</th>
            </tr>
          </thead>
          <tbody>
            {pending.map((r) => (
              <tr key={r.issue_number}>
                <td>{r.id}</td>
                <td>
                  <a
                    href={`https://github.com/alibaba/nacos/issues/${r.issue_number}`}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: "var(--accent)" }}
                  >
                    #{r.issue_number}
                  </a>
                </td>
                <td>{r.review}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>已裁决（{resolved.length}）</h2>
      <table>
        <thead>
          <tr>
            <th>id</th>
            <th>issue</th>
            <th>裁决</th>
          </tr>
        </thead>
        <tbody>
          {resolved.map((r) => (
            <tr key={r.issue_number}>
              <td>{r.id}</td>
              <td>#{r.issue_number}</td>
              <td>{r.resolution}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
