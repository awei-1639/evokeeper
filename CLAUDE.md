# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目一句话

EvoKeeper：挂在开源仓库上的自进化维护者助手 Bot（issue 分诊 + 技术问答）。核心是"经验 CI/CD"闭环——轨迹沉淀 → 睡眠式离线整理 → 候选经验 → 评测门禁 → 版本化灰度发布，越用越准、可审计可回滚。理论锚点：MetaRSI（arXiv:2609.06396）Loop Kernel。

先读 `docs/SESSION-BRIEF.md`（上下文速恢复）与 `docs/项目计划书.md`（Why/When），再看 `docs/design.md`（工程落地 How）。

## 常用命令

```bash
pnpm install                         # 需 Node 22+ / pnpm 9（本机 pnpm 走 corepack）
pnpm test                            # 根级 vitest run，收集所有 *.test.ts（真实测试在此跑）
pnpm test:watch                      # vitest watch
pnpm -r typecheck                    # 逐包 tsc --noEmit（CI 的主关卡）
pnpm triage:dryrun                   # 离线装配并打印分诊提示词（不联网）
pnpm triage:dryrun -- --limit 20 --call   # 真实跑批（需 DEEPSEEK_API_KEY）
pnpm pilot:triage -- --limit 50 --model deepseek-v4-pro  # 分诊模型选型 pilot 评测
docker compose -f infra/docker-compose.yml up -d  # pgvector:5432 / redis:6379 / langfuse:3001

# 跑单个测试文件 / 单条用例：
pnpm exec vitest run apps/agent/src/agent.test.ts
pnpm exec vitest run -t "关键字"
```

CI（`.github/workflows/ci.yml`）只跑 `pnpm -r typecheck` + `pnpm -r test`。注意：各包 `package.json` 里的 `dev`/`build` 及多数 `test` 目前是 `echo` 占位符，真实测试只在根级 `pnpm test`（vitest）里；`pnpm dev` 不会启动任何真实服务。

## 已实现 vs 占位

- **已实现**：`packages/core`（全部领域类型）、`packages/llm`（路由/计价/结构化输出/缓存，全绿 vitest）、`apps/agent`（分诊链路 + RAG 回答链路 + Inbox webhook 幂等接入 + TraceStore 轨迹库）、`packages/memory`（四操作记忆层）、`apps/worker`（失败判别器 jrv-1.0 + 睡眠整理管线 v1；门禁/发布仍占位）。
- **占位待实现**（文件头注释标了周次 W3–W8）：`apps/web`、`packages/eval`、`packages/gateway`；`apps/worker` 的 consolidate/replay/gate/release；记忆层/轨迹库/队列的 Postgres/BullMQ 适配器（等 Docker infra）。改这些时先读其 index.ts 顶部的实现说明与 `docs/design.md` 对应章节。

## 架构

pnpm monorepo，TypeScript ESM（`"type": "module"`，`moduleResolution: Bundler`，strict + `noUncheckedIndexedAccess`）。包间用 `workspace:*` 引用，入口直指 `./src/index.ts`（无构建步骤）。

- `packages/core` — 领域模型单一事实来源。所有类型（Trace / MemoryItem / ExperienceCandidate / EvalRun / GateDecision / ModelConfig 等）在此定义，文档与代码同源。
- `packages/llm` — purpose 分五档路由（triage/answer/judge/consolidate/embed），`createLlm()` 是入口。每次调用返回可写入 `TraceStep` 的 meta（model/tokens/cost）。`config.ts` 有模型规格与 DeepSeek 峰谷计价；`structured.ts` 校验失败最多重试 3 次后 `ok:false`（绝不静默降级）；judge/consolidate 缓存 TTL=0 保证评测可复现。
- `apps/agent` — `handleIssueEvent()` 消费 issue 事件；`decideActions()` 是纯函数（便于单测）。
- 数据流：`scripts/fetch-issues.mjs`（草稿池，GitHub 大数据集须跟 Link 头 `rel="next"` 游标分页，用 `page` 会 422）→ `scripts/annotate.mjs`（零依赖标注工具，localhost:8765）→ `datasets/`（JSONL 进 git）→ pilot/评测。

## 不可违反的设计红线（覆盖默认行为）

代码与文档中反复出现的 R1/R2/R3 是硬约束，改动前必须遵守：

1. **R1 评测门禁是项目灵魂**：任何经验不经 `EvalGate` 裁决不得生效。进度落后也永不砍 W6 门禁。
2. **R2 Agent 最小写权限**：动作仅限 `addLabels` / `comment` / `escalate`（`AgentAction` 白名单）。禁止改代码、发 PR、关 issue、删内容、@人。
3. **R3 一切行为必留痕**：每次 LLM 调用无论成功失败都产出可落库的 `TraceStep`（带成本 + 版本号），否则无法归因与回滚。

## 关键工程约定

- **版本即行为，禁止原地改**：改分诊提示词必须递增 `TRIAGE_PROMPT_VERSION`（`apps/agent/src/triage.ts`）；改模型映射/价格必须递增 `DEFAULT_MODEL_CONFIG.version`（`packages/llm/src/config.ts`）；判别规则递增 `JudgeRuleSet.version`。两次评测的 `ModelConfig` 快照不同则指标不可比。
- **结构化隔离（prompt 注入防护）**：issue 正文只能作为"数据"进 `<issue_body>` 等标签，绝不拼进系统指令；用 `neutralizeClosingTags` 防 `</tag>` 提前闭合。LLM 输出一律视为不可信，必须过 `parseTriage` 校验；命中 `hasInjectionSuspicion` 时照常分诊但不执行任何指令性动作。
- **输入泄漏防护**：`buildTriageMessages` 默认不喂 `rawLabels`（维护者事后打的标签=把答案喂给模型，会让 pilot/基线虚高）。
- **golden set 纪律**：`split=holdout` 定稿后永不改；禁止跨 `datasetVersion` 比较指标；标注一致性要求 Cohen's κ≥0.75（见 `docs/annotation-guideline.md`）。`datasets/**/*.backup.jsonl` 已 gitignore。
- **成本意识**：批量任务用 `isOffPeakNow()` 排到空闲时段（DeepSeek 峰谷价可省 50%）；分诊正文按 `TRIAGE_BODY_MAX_CHARS` 截断。

## Windows 环境注意

- Node 直跑 `.ts` 不可行（相对导入无扩展名会 `ERR_MODULE_NOT_FOUND`）；TS 脚本一律用 `tsx`（如 `pnpm triage:dryrun`）。
- 密钥在 `.env.local`（`GITHUB_TOKEN` / `DEEPSEEK_API_KEY`），已 gitignore，勿提交也勿回显其值。
- PowerShell 工具可能不回显 stdout；用 Glob/Read 校验命令结果。
