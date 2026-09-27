/**
 * 候选经验存储（W5-W6）—— 整理管线产出 → 人工评审 → 发布
 *
 * 状态流转（ExperienceCandidate.status）：
 *   proposed（整理产出）→ evaluating → approved（人工评审通过，可发布）
 *                                     → rejected（人工否决）
 *   approved 且门禁 PASSED → createRelease → released
 *
 * JSONL 落盘：一行一条候选，append 产出、整文件重写更新状态（W5 规模足够）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ExperienceCandidate } from "@evokeeper/core";

export interface CandidateStore {
  append(candidate: ExperienceCandidate): Promise<void>;
  list(): Promise<ExperienceCandidate[]>;
  get(id: string): Promise<ExperienceCandidate | null>;
  /** 评审状态流转（proposed → approved / rejected 由人工触发） */
  updateStatus(id: string, status: ExperienceCandidate["status"]): Promise<ExperienceCandidate>;
}

export class JsonlCandidateStore implements CandidateStore {
  constructor(private readonly filePath: string) {
    mkdirSync(path.dirname(filePath), { recursive: true });
  }

  private load(): ExperienceCandidate[] {
    if (!existsSync(this.filePath)) return [];
    return readFileSync(this.filePath, "utf8")
      .trim()
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as ExperienceCandidate);
  }

  private flush(candidates: readonly ExperienceCandidate[]): void {
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(
      tmp,
      candidates.map((c) => JSON.stringify(c)).join("\n") + "\n",
      "utf8"
    );
    renameSync(tmp, this.filePath);
  }

  async append(candidate: ExperienceCandidate): Promise<void> {
    const list = this.load();
    if (list.some((c) => c.id === candidate.id)) {
      throw new Error(`候选 id 重复：${candidate.id}`);
    }
    list.push(candidate);
    this.flush(list);
  }

  async list(): Promise<ExperienceCandidate[]> {
    return this.load().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async get(id: string): Promise<ExperienceCandidate | null> {
    return this.load().find((c) => c.id === id) ?? null;
  }

  async updateStatus(id: string, status: ExperienceCandidate["status"]): Promise<ExperienceCandidate> {
    const list = this.load();
    const idx = list.findIndex((c) => c.id === id);
    if (idx < 0) throw new Error(`候选不存在：${id}`);
    const current = list[idx];
    if (!current) throw new Error(`候选不存在：${id}`);
    const updated: ExperienceCandidate = { ...current, status };
    list[idx] = updated;
    this.flush(list);
    return updated;
  }
}
