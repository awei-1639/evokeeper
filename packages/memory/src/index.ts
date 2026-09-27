/**
 * 四类记忆层（W3）—— design.md §4，依据 D5（Mem0 式在线四操作）
 *
 * 四操作判定（纯函数，必须全覆盖单测——W3 DoD）：
 * - 新事实且无冲突 → ADD；
 * - 同实体更新 → UPDATE 优先于 ADD（evidenceRefs 追加，confidence 取高者）；
 * - 事实失效 → DELETE 软删（置 validUntil，绝不物理删除）；
 * - 无信息量 / 在位记忆更优 → NONE 跳过。
 * 冲突消解：同实体以 confidence 高者为准，并列时取证据链更长者。
 * 检索：W3 为词法匹配 + (repo, kind, expectedSlice) 硬过滤，Top-K=5，只带结论不带推理
 * （最小上下文原则）；W4 embedding 就绪后只换相似度实现，过滤与裁剪不变。
 *
 * 失效策略按 kind（design.md §4）：episodic 随 Trace 归档、semantic 靠 validUntil、
 * procedural 版本化随 ReleaseVersion 回滚（W5 技能文件化）、preference 长期人工修订。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { MemoryItem, MemoryKind } from "@evokeeper/core";

export type MemoryWriteOp = "ADD" | "UPDATE" | "DELETE" | "NONE";

export { type MemoryItem, type MemoryKind } from "@evokeeper/core";

// ---------- 四操作判定（纯函数） ----------

export interface MemoryCandidate {
  repo: string;
  kind: MemoryKind;
  content: string;
  confidence: number;
  evidenceRefs: string[];
  validUntil?: string | null;
  expectedSlice?: string | null;
  /**
   * 该事实宣告既有记忆失效（如"X 已在 v3 移除"）。
   * 命中同实体高重叠项时触发 DELETE 软删而非 UPDATE。
   */
  invalidates?: boolean;
  now?: string;
}

export interface MemoryOpDecision {
  op: MemoryWriteOp;
  /** UPDATE / DELETE 的目标记忆 id */
  targetId: string | null;
  reason: string;
}

/** 内容无信息量的判定下限（短于该长度视为噪声） */
const MIN_CONTENT_CHARS = 8;
/** 同实体判定：重叠系数（交集/较短集）≥ HIGH 且绝对交集 ≥ MIN_INTERSECT */
const OVERLAP_HIGH = 0.5;
/** 相关判定阈值（低于则视为无冲突的新事实） */
const OVERLAP_LOW = 0.25;
const MIN_INTERSECT = 3;

function tokenizeForOverlap(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .match(/[a-z0-9_+#.\-]{2,}|[\u4e00-\u9fff]{2}/g) ?? [];
  return new Set(tokens);
}

/**
 * 重叠系数 = 交集 / 较短集合。不用 Jaccard：长短句改写（同实体、不同详略）
 * 会被并集稀释；"包含式改写"恰是记忆更新最常见的形态。
 */
function overlapCoefficient(a: Set<string>, b: Set<string>): { coef: number; inter: number } {
  if (a.size === 0 || b.size === 0) return { coef: 0, inter: 0 };
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (large.has(t)) inter++;
  return { coef: inter / small.size, inter };
}

/** 与既有记忆的最相似项及其重叠度（仅同 repo 同 kind 内比较） */
function bestMatch(
  candidate: MemoryCandidate,
  existing: readonly MemoryItem[]
): { item: MemoryItem | null; overlap: number; inter: number } {
  const candTokens = tokenizeForOverlap(candidate.content);
  let best: MemoryItem | null = null;
  let bestOverlap = 0;
  let bestInter = 0;
  for (const item of existing) {
    if (item.repo !== candidate.repo || item.kind !== candidate.kind) continue;
    const { coef, inter } = overlapCoefficient(candTokens, tokenizeForOverlap(item.content));
    if (coef > bestOverlap) {
      best = item;
      bestOverlap = coef;
      bestInter = inter;
    }
  }
  return { item: best, overlap: bestOverlap, inter: bestInter };
}

/**
 * 四操作判定。existing 由调用方提供（同 repo 全量或检索命中集）；
 * 判定只依赖输入，绝不隐式读存储——保证可回放（R3）。
 */
export function decideMemoryOp(
  candidate: MemoryCandidate,
  existing: readonly MemoryItem[]
): MemoryOpDecision {
  if (candidate.content.trim().length < MIN_CONTENT_CHARS) {
    return { op: "NONE", targetId: null, reason: "内容无信息量（过短）" };
  }

  const { item, overlap, inter } = bestMatch(candidate, existing);
  const sameEntity = overlap >= OVERLAP_HIGH && inter >= MIN_INTERSECT;
  const related = overlap >= OVERLAP_LOW && inter >= MIN_INTERSECT;

  if (!item || !related) {
    return { op: "ADD", targetId: null, reason: "新事实且无冲突（无相关在位记忆）" };
  }

  if (candidate.invalidates === true && sameEntity) {
    return {
      op: "DELETE",
      targetId: item.id,
      reason: `事实失效：与 ${item.id} 重叠 ${(overlap * 100).toFixed(0)}%，软删置 validUntil`,
    };
  }

  if (!sameEntity) {
    // 相关但未达同实体阈值：按冲突消解决定是否值得新增
    if (candidate.confidence > item.confidence) {
      return { op: "ADD", targetId: null, reason: "相关但非同实体，confidence 更高故新增" };
    }
    return {
      op: "NONE",
      targetId: null,
      reason: `与 ${item.id} 部分重叠（${(overlap * 100).toFixed(0)}%）且在位记忆更优，跳过`,
    };
  }

  // 同实体：UPDATE 优先于 ADD，冲突消解
  if (candidate.confidence > item.confidence) {
    return {
      op: "UPDATE",
      targetId: item.id,
      reason: `同实体更新（重叠 ${(overlap * 100).toFixed(0)}%），confidence 更高`,
    };
  }
  if (candidate.confidence === item.confidence) {
    if (candidate.evidenceRefs.length > item.evidenceRefs.length) {
      return { op: "UPDATE", targetId: item.id, reason: "同实体更新，confidence 并列但证据链更长" };
    }
    return {
      op: "NONE",
      targetId: null,
      reason: "同实体且在位记忆不弱于新事实（confidence 并列、证据链不长），跳过",
    };
  }
  return {
    op: "NONE",
    targetId: null,
    reason: `同实体且在位记忆 confidence 更高（${item.confidence}），跳过`,
  };
}

// ---------- 存储接口与实现 ----------

export interface MemoryStore {
  get(id: string): Promise<MemoryItem | null>;
  /** 同 repo 的全部在位记忆（四操作判定的输入；PG 版可换向量预筛） */
  listByRepo(repo: string): Promise<MemoryItem[]>;
  save(item: MemoryItem): Promise<void>;
  /** DELETE 为软删：置 validUntil，保留审计链（R3） */
  softDelete(id: string, validUntil: string): Promise<void>;
}

export class InMemoryMemoryStore implements MemoryStore {
  private readonly items = new Map<string, MemoryItem>();

  async get(id: string): Promise<MemoryItem | null> {
    return this.items.get(id) ?? null;
  }

  async listByRepo(repo: string): Promise<MemoryItem[]> {
    return [...this.items.values()].filter((i) => i.repo === repo);
  }

  async save(item: MemoryItem): Promise<void> {
    this.items.set(item.id, item);
  }

  async softDelete(id: string, validUntil: string): Promise<void> {
    const item = this.items.get(id);
    if (!item) throw new Error(`记忆不存在：${id}`);
    this.items.set(id, { ...item, validUntil });
  }

  get size(): number {
    return this.items.size;
  }
}

/** JSONL 落盘实现：一行一条记忆（含软删后的 validUntil 状态），启动时加载，写入同步刷盘 */
export class JsonlMemoryStore implements MemoryStore {
  private readonly items = new Map<string, MemoryItem>();

  constructor(private readonly filePath: string) {
    if (existsSync(filePath)) {
      for (const line of readFileSync(filePath, "utf8").trim().split("\n")) {
        if (!line) continue;
        const item = JSON.parse(line) as MemoryItem;
        this.items.set(item.id, item);
      }
    }
  }

  async get(id: string): Promise<MemoryItem | null> {
    return this.items.get(id) ?? null;
  }

  async listByRepo(repo: string): Promise<MemoryItem[]> {
    return [...this.items.values()].filter((i) => i.repo === repo);
  }

  async save(item: MemoryItem): Promise<void> {
    this.items.set(item.id, item);
    this.flush();
  }

  async softDelete(id: string, validUntil: string): Promise<void> {
    const item = this.items.get(id);
    if (!item) throw new Error(`记忆不存在：${id}`);
    this.items.set(id, { ...item, validUntil });
    this.flush();
  }

  /** 整文件重写（W3 规模下足够；PG 版替换为 UPDATE 语句） */
  private flush(): void {
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(
      tmp,
      [...this.items.values()].map((i) => JSON.stringify(i)).join("\n") + "\n",
      "utf8"
    );
    renameSync(tmp, this.filePath);
  }
}

// ---------- 记忆层门面 ----------

export interface MemoryWriteRequest extends MemoryCandidate {
  /** 不传则自动生成 mem-<n> */
  id?: string;
}

export interface MemoryWriteResult {
  op: MemoryWriteOp;
  itemId: string | null;
  targetId: string | null;
  reason: string;
}

export interface MemoryQuery {
  repo: string;
  kind?: MemoryKind;
  /** 预期切片硬过滤（如 "labels=bug & topic=build-error"），不传不过滤 */
  expectedSlice?: string;
  limit?: number;
  /** 时钟注入：validUntil 早于 now 的条目不返回（默认系统时间） */
  now?: string;
}

export interface MemoryLayerOptions {
  store?: MemoryStore;
  /** id 生成器，默认 mem-<自增>；测试可注入固定序列 */
  genId?: () => string;
}

/**
 * 记忆层门面：写路径走四操作判定，读路径硬过滤 + 失效过滤 + 最小上下文。
 * 每次写入的判定结果由调用方（或轨迹）留痕。
 */
export class MemoryLayer {
  private readonly store: MemoryStore;
  private readonly genId: () => string;
  private counter = 0;

  constructor(options: MemoryLayerOptions = {}) {
    this.store = options.store ?? new InMemoryMemoryStore();
    this.genId =
      options.genId ??
      (() => {
        this.counter += 1;
        return `mem-${this.counter}`;
      });
  }

  async write(req: MemoryWriteRequest): Promise<MemoryWriteResult> {
    const existing = await this.store.listByRepo(req.repo);
    const decision = decideMemoryOp(req, existing);
    const now = req.now ?? new Date().toISOString();

    if (decision.op === "NONE") {
      return { ...decision, itemId: null };
    }

    if (decision.op === "DELETE" && decision.targetId) {
      await this.store.softDelete(decision.targetId, now);
      return { ...decision, itemId: null };
    }

    if (decision.op === "ADD") {
      const item: MemoryItem = {
        id: req.id ?? this.genId(),
        repo: req.repo,
        kind: req.kind,
        content: req.content,
        evidenceRefs: [...req.evidenceRefs],
        confidence: req.confidence,
        validUntil: req.validUntil ?? null,
        expectedSlice: req.expectedSlice ?? null,
        version: "1",
        createdAt: now,
      };
      await this.store.save(item);
      return { ...decision, itemId: item.id };
    }

    // UPDATE：内容替换、证据链追加、confidence 取高、版本递增
    const target = decision.targetId ? await this.store.get(decision.targetId) : null;
    if (!target) {
      // 竞态兜底：目标消失则退化为普通写入（不再触发失效）
      return this.write({ ...req, invalidates: false });
    }
    const versionNum = Number(target.version);
    const updated: MemoryItem = {
      ...target,
      content: req.content,
      confidence: Math.max(req.confidence, target.confidence),
      evidenceRefs: [...new Set([...target.evidenceRefs, ...req.evidenceRefs])],
      validUntil: req.validUntil ?? target.validUntil,
      expectedSlice: req.expectedSlice ?? target.expectedSlice,
      version: String(Number.isFinite(versionNum) ? versionNum + 1 : 1),
    };
    await this.store.save(updated);
    return { ...decision, itemId: updated.id };
  }

  /**
   * 读路径：repo 硬过滤 + 可选 kind/expectedSlice → 剔除已失效（validUntil < now）
   * → confidence 降序 → Top-K（默认 5）。只返回结论内容本身（最小上下文）。
   */
  async query(query: MemoryQuery): Promise<MemoryItem[]> {
    const all = await this.store.listByRepo(query.repo);
    const now = query.now ?? new Date().toISOString();
    const nowMs = Date.parse(now);
    return all
      .filter((i) => (query.kind ? i.kind === query.kind : true))
      .filter((i) => (query.expectedSlice ? i.expectedSlice === query.expectedSlice : true))
      .filter((i) => i.validUntil === null || Date.parse(i.validUntil) > nowMs)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, query.limit ?? 5);
  }

  /** 人工修订入口（preference 类的长期维护路径） */
  async update(
    id: string,
    patch: Partial<Pick<MemoryItem, "content" | "confidence" | "expectedSlice">>
  ): Promise<MemoryItem> {
    const item = await this.store.get(id);
    if (!item) throw new Error(`记忆不存在：${id}`);
    const versionNum = Number(item.version);
    const updated: MemoryItem = {
      ...item,
      ...patch,
      version: String(Number.isFinite(versionNum) ? versionNum + 1 : 1),
    };
    await this.store.save(updated);
    return updated;
  }
}
