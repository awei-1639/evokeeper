/** 管理台数据读取层：全部只读，数据源是仓库内的 JSONL / JSON 工件 */
import fs from "node:fs";
import path from "node:path";

/** next 进程 cwd 是 apps/web，仓库根在上两级 */
export const REPO_ROOT = path.resolve(process.cwd(), "..", "..");

export type Json = Record<string, unknown>;

export function readJsonl(rel: string): Json[] {
  const abs = path.join(REPO_ROOT, rel);
  if (!fs.existsSync(abs)) return [];
  return fs
    .readFileSync(abs, "utf8")
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Json);
}

export function readJson<T = Json>(rel: string): T | null {
  const abs = path.join(REPO_ROOT, rel);
  if (!fs.existsSync(abs)) return null;
  return JSON.parse(fs.readFileSync(abs, "utf8")) as T;
}

export function listJsonFiles(rel: string): string[] {
  const abs = path.join(REPO_ROOT, rel);
  if (!fs.existsSync(abs)) return [];
  return fs
    .readdirSync(abs)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => path.join(rel, f));
}

export function exists(rel: string): boolean {
  return fs.existsSync(path.join(REPO_ROOT, rel));
}

export function mainLabel(labels: unknown): string {
  const arr = Array.isArray(labels) ? (labels as string[]) : [];
  const main = arr.find((l) => ["bug", "feature", "question", "duplicate", "invalid"].includes(l));
  return main ?? "invalid";
}

/** EvalRun JSON（eval:run 产出：{ run, nmi, perCaseDetail }）的关键指标视图 */
export interface EvalRunView {
  file: string;
  id: string;
  split: string;
  datasetVersion: string;
  model: string;
  modelConfigVersion: string;
  promptVersion: string | null;
  accuracyPct: number;
  macroF1: number;
  ciLowerPct: number | null;
  ciUpperPct: number | null;
  costPerIssue: number;
  p95LatencyMs: number;
  nmiHit: number | null;
  nmiGold: number | null;
  nmiFalsePositives: number | null;
}

export function toEvalRunView(file: string, raw: Json): EvalRunView {
  const run = (raw["run"] ?? raw) as Json;
  const metrics = (run["metrics"] ?? {}) as Json;
  const mc = (run["modelConfig"] ?? {}) as Json;
  const ci = run["ci95"] as Json | null;
  const nmi = raw["nmi"] as Json | null;
  return {
    file,
    id: String(run["id"] ?? file),
    split: String(run["split"] ?? ""),
    datasetVersion: String(run["datasetVersion"] ?? ""),
    model: String(mc["routing"] ? (mc["routing"] as Json)["triage"] ?? "" : run["model"] ?? ""),
    modelConfigVersion: String(mc["version"] ?? ""),
    promptVersion: (run["promptVersion"] as string | null) ?? null,
    accuracyPct: Number(metrics["triageAccuracy"] ?? 0) * 100,
    macroF1: Number(metrics["triageMacroF1"] ?? 0),
    ciLowerPct: ci ? Number(ci["lower"]) * 100 : null,
    ciUpperPct: ci ? Number(ci["upper"]) * 100 : null,
    costPerIssue: Number(metrics["costPerIssue"] ?? 0),
    p95LatencyMs: Number(metrics["p95LatencyMs"] ?? 0),
    nmiHit: nmi ? Number(nmi["hit"]) : null,
    nmiGold: nmi ? Number(nmi["goldCount"]) : null,
    nmiFalsePositives: nmi ? Number(nmi["falsePositives"]) : null,
  };
}
