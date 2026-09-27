"use server";

/**
 * 发布控制台的写动作（W7 v1）：候选经验的人工评审。
 * 约束：只流转状态（proposed → approved / rejected）；真正的发布必须
 * 走 worker 的 createRelease（门禁 PASSED + approved + diff 三校验，§8）。
 */
import { revalidatePath } from "next/cache";
import { JsonlCandidateStore } from "@evokeeper/worker";

const CANDIDATES_FILE = "datasets/candidates/candidates.jsonl";

function store() {
  // cwd = apps/web，仓库根在上两级
  return new JsonlCandidateStore(`../../${CANDIDATES_FILE}`);
}

export async function approveCandidate(id: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await store().updateStatus(id, "approved");
    revalidatePath("/releases");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function rejectCandidate(id: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await store().updateStatus(id, "rejected");
    revalidatePath("/releases");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
