import { listJsonFiles, mainLabel, readJson, readJsonl, type Json } from "@/lib/data";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default function OverviewPage() {
  const golden = readJsonl("datasets/drafts/alibaba_nacos.jsonl");
  const annotated = golden.filter((g) => Array.isArray(g["labels_gold"]) && (g["labels_gold"] as string[]).length > 0);
  const withQa = annotated.filter((g) => g["qa"]);
  const reviews = readJson<{ length?: number }>("datasets/ai-annotation/round1/reviews.json");
  const reviewPending = typeof reviews?.length === "number" ? reviews.length : 0;
  const adversarial = readJsonl("datasets/adversarial.jsonl");
  const advCheck = readJson<{ pass?: number; total?: number }>("datasets/pilot/adversarial-check-deepseek-v4-flash.json");
  const evalFiles = listJsonFiles("datasets/eval");
  const latestEval = evalFiles.length > 0 ? readJson(evalFiles[evalFiles.length - 1] ?? "") : null;
  const latestMetrics = (latestEval?.["run"] as Json | undefined)?.["metrics"] as Json | undefined;
  const releases = readJsonl("datasets/releases/releases.jsonl");

  const labelDist = annotated.reduce<Record<string, number>>((acc, g) => {
    const k = mainLabel(g["labels_gold"]);
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <>
      <h1>项目概览</h1>
      <p className="muted">
        EvoKeeper：挂在 alibaba/nacos 上的自进化维护者助手。经验 CI/CD：轨迹 → 判别 → 整理 → 门禁 → 发布。
      </p>

      <div className="cards">
        <div className="card">
          <div className="num">{annotated.length}/{golden.length}</div>
          <div className="label">Golden Set 已标注 / 草稿池</div>
        </div>
        <div className="card">
          <div className="num">{withQa.length}</div>
          <div className="label">含 QA（回答评测轨道）</div>
        </div>
        <div className="card">
          <div className="num">
            {(Number(latestMetrics?.["triageAccuracy"] ?? 0) * 100).toFixed(1)}%
          </div>
          <div className="label">最新 dev 基线准确率</div>
        </div>
        <div className="card">
          <div className="num">
            {advCheck?.pass ?? adversarial.length}/{adversarial.length}
          </div>
          <div className="label">对抗防线通过</div>
        </div>
        <div className="card">
          <div className="num">{reviewPending}</div>
          <div className="label">待人工仲裁（ reviews.json ）</div>
        </div>
        <div className="card">
          <div className="num">{releases.length}</div>
          <div className="label">已发布经验版本</div>
        </div>
      </div>

      <h2>主标签分布（全量 {annotated.length}）</h2>
      <table>
        <tbody>
          {Object.entries(labelDist)
            .sort((a, b) => b[1] - a[1])
            .map(([label, n]) => (
              <tr key={label}>
                <td>
                  <span className="tag">{label}</span>
                </td>
                <td>{n}</td>
                <td className="muted">{((n / Math.max(1, annotated.length)) * 100).toFixed(1)}%</td>
              </tr>
            ))}
        </tbody>
      </table>

      <h2>快捷入口</h2>
      <ul>
        <li><Link href="/evals">评测报告（EvalRun / pilot / 门禁输入）</Link></li>
        <li><Link href="/golden">Golden Set 浏览（按标注者 / split / 主标签过滤）</Link></li>
        <li><Link href="/review">仲裁清单（AI 标注 review 项）</Link></li>
        <li><Link href="/traces">轨迹查看器</Link></li>
      </ul>
    </>
  );
}
