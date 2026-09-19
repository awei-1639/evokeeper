/**
 * 查询级决策缓存 —— design.md §9：缓存键 = (configVersion, purpose, model, 归一化输入)
 * judge / consolidate 的 TTL 为 0（必须可重跑，否则评测不可复现）。
 */

export interface LlmCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
}

/** 归一化：压缩空白并小写，避免因格式差异击穿缓存 */
export function normalizeInput(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** FNV-1a 32 位哈希，仅用于构造缓存键（非加密用途） */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function buildCacheKey(parts: {
  configVersion: string;
  purpose: string;
  model: string;
  system: string;
  user: string;
}): string {
  return [
    parts.configVersion,
    parts.purpose,
    parts.model,
    fnv1a(normalizeInput(parts.system)),
    fnv1a(normalizeInput(parts.user)),
  ].join(":");
}

/** 各 purpose 默认 TTL（毫秒）；0 表示不缓存 */
export const DEFAULT_TTL_MS: Record<string, number> = {
  triage: 24 * 3600_000,
  answer: 6 * 3600_000,
  judge: 0,
  consolidate: 0,
  embed: 7 * 24 * 3600_000,
};

/** 进程内缓存（Redis 版待 infra 就绪后替换，接口保持一致） */
export function createMemoryCache(): LlmCache {
  const store = new Map<string, { value: string; expiresAt: number }>();
  return {
    async get(key: string): Promise<string | null> {
      const hit = store.get(key);
      if (!hit) return null;
      if (hit.expiresAt < Date.now()) {
        store.delete(key);
        return null;
      }
      return hit.value;
    },
    async set(key: string, value: string, ttlMs: number): Promise<void> {
      if (ttlMs <= 0) return;
      store.set(key, { value, expiresAt: Date.now() + ttlMs });
    },
  };
}
