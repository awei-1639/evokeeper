/**
 * 问答钩子（W5）—— issue 评论提问 → BM25 证据 → LLM 回答 → 评论动作
 *
 * 挂在 handleIssueEvent 之后（组合而非侵入）：先照常分诊，再判断"这条评论
 * 是不是在提问"，是则检索社区语料并生成带引用护栏的回答，追加 comment 动作。
 *
 * 纪律（与分诊同源）：
 * - 语料是"社区已知知识"（历史 issue + 维护者回复），引用必须真实存在（护栏在
 *   answer.ts 已实现），本模块只做跨仓库改写：语料 issue 号引用改写为
 *   `<语料仓库>#N`，避免在目标仓库里误导性指向本仓库的同号 issue；
 * - 回答置信度 < 0.5 只留痕不发言（design.md §3.3 同阈值）；
 * - 分诊已产生评论动作时不再叠加（gateway 单次执行 ≤1 评论）；
 * - bot 自己的评论不触发（防自激循环；inbox 层也有一道 Bot 过滤，双保险）。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Llm } from "@evokeeper/llm";
import { handleIssueEvent, type HandleIssueEventDeps, type HandleResult, type IssueEvent } from "./index";
import { answerQuestion, ANSWER_MAX_EVIDENCE } from "./answer";
import { BM25Index, buildEvidence, loadCorpusFromJsonl } from "./retrieval";

/** 默认社区语料：nacos 300 条（历史 issue + 维护者回复摘要） */
export const DEFAULT_CORPUS_PATH = "datasets/drafts/alibaba_nacos.jsonl";

/** 提问意图的启发式（宁漏勿滥：错过一个问题只是没答，误答一次是噪音） */
const QUESTION_RE =
  /[?？]|怎么|如何|为什么|怎么回事|怎么办|请教|求助|帮忙|有没有|help me|how (?:to|can|do)|why\b/i;

/** 回答发言的置信度门槛（与分诊 CONFIDENCE_THRESHOLD 同值，design.md §3.3） */
export const ANSWER_CONFIDENCE_THRESHOLD = 0.5;

export interface QaHookOptions {
  llm?: Llm;
  corpusPath?: string;
  /** 语料所属仓库（跨仓库引用改写用）；缺省从语料首行 repo 字段推断 */
  evidenceRepo?: string;
  topK?: number;
  log?: (msg: string) => void;
}

export interface QaAwareHandle {
  (event: IssueEvent, deps?: HandleIssueEventDeps): Promise<HandleResult>;
}

export function createQaAwareHandle(options: QaHookOptions = {}): QaAwareHandle {
  const log = options.log ?? (() => {});
  const corpusPath = options.corpusPath ?? DEFAULT_CORPUS_PATH;
  const corpus = loadCorpusFromJsonl(resolve(process.cwd(), corpusPath));
  const index = new BM25Index(corpus);
  // 语料所属仓库从首行 repo 字段推断（跨仓库引用改写：#N → <repo>#N）
  const firstLine = readFileSync(resolve(process.cwd(), corpusPath), "utf8").trim().split("\n")[0] ?? "{}";
  const evidenceRepo = options.evidenceRepo ?? (JSON.parse(firstLine) as { repo?: string }).repo ?? "unknown/repo";
  log(`[qa] 语料 ${corpus.length} 条（${evidenceRepo}）已索引`);

  return async (event, deps = {}) => {
    // 分诊与回答共用同一个 LLM 实例（线上传入的是按 §9.1 降级后的 config）
    const merged: HandleIssueEventDeps = { ...deps, llm: deps.llm ?? options.llm };
    const result = await handleIssueEvent(event, merged);

    const last = event.comments?.[event.comments.length - 1];
    if (!last) return result; // 非 comment 触发，不答
    if (last.author.endsWith("[bot]")) return result; // 双保险：自己的评论不答
    if (!QUESTION_RE.test(last.body)) return result; // 不是提问，不答
    if (result.actions.some((a) => a.kind === "comment")) return result; // 分诊模板评论优先，不叠加

    const question = last.body;
    const matches = index.search(question, options.topK ?? ANSWER_MAX_EVIDENCE);
    const evidence = buildEvidence(matches);
    const answered = await answerQuestion({ repo: event.repo, question, evidence }, { llm: options.llm });

    // 步骤序号接在分诊之后（R3：一次处理一条完整轨迹）
    const baseSeq = Math.max(0, ...result.steps.map((s) => s.seq));
    for (const [i, s] of answered.steps.entries()) {
      result.steps.push({ ...s, seq: baseSeq + i + 1 });
    }

    if (answered.escalated || answered.confidence < ANSWER_CONFIDENCE_THRESHOLD || !answered.answer) {
      log(`[qa] #${event.issueNumber} 回答未达发言门槛（conf=${answered.confidence.toFixed(2)}${answered.escalated ? " escalated" : ""}），只留痕`);
      return result;
    }

    // 跨仓库引用改写：#14495 → alibaba/nacos#14495（GitHub 自动跨仓链接）
    const validNumbers = new Set(evidence.map((e) => `#${e.issueNumber}`));
    const body = answered.answer.replace(/#(\d+)/g, (m) =>
      validNumbers.has(m) ? `${evidenceRepo}${m}` : m
    );

    result.actions.push({ kind: "comment", body, quoteRefs: answered.citations });
    log(`[qa] #${event.issueNumber} 回答就绪（conf=${answered.confidence.toFixed(2)}，证据 ${evidence.length} 条）`);
    return result;
  };
}
