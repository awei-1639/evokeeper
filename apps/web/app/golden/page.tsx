import { mainLabel, readJsonl } from "@/lib/data";
import Link from "next/link";

export const dynamic = "force-dynamic";

const MAIN = ["bug", "feature", "question", "duplicate", "invalid"];

export default async function GoldenPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const filterLabel = typeof sp["label"] === "string" ? sp["label"] : "";
  const filterAnnotator = typeof sp["annotator"] === "string" ? sp["annotator"] : "";

  const rows = readJsonl("datasets/drafts/alibaba_nacos.jsonl")
    .filter((r) => Array.isArray(r["labels_gold"]) && (r["labels_gold"] as string[]).length > 0)
    .filter((r) => !filterLabel || mainLabel(r["labels_gold"]) === filterLabel)
    .filter((r) => !filterAnnotator || r["annotator"] === filterAnnotator);

  const chip = (label: string, href: string, active: boolean) => (
    <Link key={href + label} href={href} className={`tag${active ? " ok" : ""}`} style={{ marginRight: 6 }}>
      {label}
    </Link>
  );

  return (
    <>
      <h1>Golden Set 浏览</h1>
      <p className="muted">
        数据源：datasets/drafts/alibaba_nacos.jsonl（分诊标注 300 条；QA 127 条）。holdout 落锁后只读。
      </p>

      <div>
        <span className="muted">主标签：</span>
        {chip("全部", "/golden", !filterLabel)}
        {MAIN.map((l) => chip(l, `/golden?label=${l}`, filterLabel === l))}
      </div>
      <div style={{ marginTop: 8 }}>
        <span className="muted">标注者：</span>
        {chip("全部", `/golden${filterLabel ? `?label=${filterLabel}` : ""}`, !filterAnnotator)}
        {chip("v1（人工）", `/golden?annotator=v1${filterLabel ? `&label=${filterLabel}` : ""}`, filterAnnotator === "v1")}
        {chip("ai-v1", `/golden?annotator=ai-v1${filterLabel ? `&label=${filterLabel}` : ""}`, filterAnnotator === "ai-v1")}
      </div>

      <table>
        <thead>
          <tr>
            <th>id</th>
            <th>issue</th>
            <th>主标签</th>
            <th>difficulty</th>
            <th>标注者</th>
            <th>QA</th>
            <th>标题</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const qa = r["qa"] as Json | null | undefined;
            return (
              <tr key={String(r["id"])}>
                <td>{String(r["id"])}</td>
                <td>
                  <a href={String(r["url"] ?? "#")} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
                    #{String(r["issue_number"])}
                  </a>
                </td>
                <td>
                  <span className="tag">{mainLabel(r["labels_gold"])}</span>
                  {(r["labels_gold"] as string[]).includes("needs-more-info") && (
                    <span className="tag" style={{ marginLeft: 4 }}>
                      +nmi
                    </span>
                  )}
                </td>
                <td>{String(r["difficulty"] ?? "")}</td>
                <td>{String(r["annotator"] ?? "")}</td>
                <td>{qa ? "✓" : "—"}</td>
                <td>{String(r["title"] ?? "").slice(0, 60)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="muted">共 {rows.length} 条</p>
    </>
  );
}

interface Json {
  [key: string]: unknown;
}
