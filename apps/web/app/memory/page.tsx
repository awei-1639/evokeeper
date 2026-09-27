import { exists, readJsonl } from "@/lib/data";

export const dynamic = "force-dynamic";

export default function MemoryPage() {
  const file = "datasets/memory/memory.jsonl";
  const items = exists(file)
    ? readJsonl(file).sort((a, b) => String(b["createdAt"]).localeCompare(String(a["createdAt"])))
    : [];

  return (
    <>
      <h1>记忆时间线</h1>
      <p className="muted">
        数据源：datasets/memory/memory.jsonl（运行时通过
        <code> JsonlMemoryStore </code>
        持久化；软删条目置 validUntil，保留审计链）。
      </p>

      {items.length === 0 ? (
        <div className="empty">
          还没有持久化记忆。记忆在整理管线产出（W5 睡眠整理 → 人工评审 → 门禁通过后写入）
          或人工登记 preference 类条目时产生；当前评测链路尚未产生过门禁通过的发布。
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>id</th>
              <th>类型</th>
              <th>内容</th>
              <th>confidence</th>
              <th>版本</th>
              <th>失效时间</th>
              <th>创建时间</th>
            </tr>
          </thead>
          <tbody>
            {items.map((m) => {
              const expired = m["validUntil"] ? String(m["validUntil"]) < new Date().toISOString() : false;
              return (
                <tr key={String(m["id"])}>
                  <td>{String(m["id"])}</td>
                  <td>
                    <span className="tag">{String(m["kind"])}</span>
                  </td>
                  <td>{String(m["content"]).slice(0, 120)}</td>
                  <td>{Number(m["confidence"]).toFixed(2)}</td>
                  <td>{String(m["version"])}</td>
                  <td>
                    {m["validUntil"] ? (
                      expired ? (
                        <span className="tag bad">已失效</span>
                      ) : (
                        String(m["validUntil"]).slice(0, 10)
                      )
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>{String(m["createdAt"]).slice(0, 10)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}
