# EvoKeeper 会话简报（给未来任何工作区的接续说明）

> 用途：当你（AI 助手）在新的工作区/会话中接到本项目时，先读本文件与 `项目计划书.md`，即可恢复全部上下文。最近更新：2026-09-27。

## 1. 项目一句话

EvoKeeper：挂在开源仓库上的自进化维护者助手 Bot（issue 分诊 + 技术问答），核心是"经验 CI/CD"闭环——轨迹沉淀 → 睡眠式整理 → 候选经验 → 评测门禁 → 版本化灰度发布，越用越准、可审计可回滚。理论锚点：MetaRSI（arXiv:2609.06396）Loop Kernel / Harness-RSI。

## 2. 当前进度（W1 收尾 / W2 已开工，更新于 2026-09-27）

- ✅ pnpm monorepo 脚手架（apps: agent/worker/web 占位；packages/core 已有完整领域类型）
- ✅ golden set 标注规范 `docs/annotation-guideline.md` + 示例数据 `datasets/examples/`
- ✅ W1 论文精读指南 `docs/papers/W1-reading-guide.md`（MetaRSI/AWM/Voyager/Reflexion/Mem0）
- ✅ git 首提交 0ce4ea3
- ✅ 论文精读完成：`docs/design-notes.md`（Loop Kernel↔EvoKeeper 映射表、5 个设计决策 D1-D5、睡眠整理流程草图、技能文件格式草案、记忆写路径、MetaRSI 采纳/不采纳清单）。新增决策：unclear（无反应）轨迹默认不进整理管线，待并入计划书 §5.1
- ✅ 本地骨架验证：pnpm install + `pnpm -r typecheck` 全绿（补齐 6 个缺失的 tsconfig.json、4 个包补 "types" 字段——修复前 CI 必挂）；docker compose 验证受阻：本机未装 Docker
- ✅ 主仓库定为 **alibaba/nacos**：GitHub 搜索 API 实测近 6 个月新 issue 327 条（满足 ≥150 硬条件）；Sa-Token 32 条 / mybatis-plus 61 条不达标已淘汰
- ✅ golden set 工具：`scripts/fetch-issues.mjs`（草稿池生成器：滤 PR/无回复、按月分层、脱敏+截断；GitHub 大数据集须跟随 Link 头 rel="next" 游标分页，用 page 参数会 422）；草稿池 `datasets/drafts/alibaba_nacos.jsonl`（300 条，覆盖 13 个月，全部已关闭可标 QA）
- ✅ 标注工具：`scripts/annotate.mjs` + `scripts/annotate.html`（零依赖，`node scripts/annotate.mjs` → localhost:8765）
- ✅ 系统设计说明书 `docs/design.md` v1.0（补齐"计划书=Why/When"与"design-notes=论文依据"之间的工程落地层）；`packages/core` 新增 `JudgeRuleSet` / `ConsolidationJob` / `CanaryMetrics`
- ✅ design.md v1.2：§3.1 新增输入泄漏防护（issue 已有标签默认不进上下文），§9.1 补落地状态
- ✅ **W2 地基（LLM 路由层 + 分诊 prompt）已完成并验证**：
  - `packages/llm`：`config.ts`（ModelConfig 落地 + 5 个模型规格 + DeepSeek 峰谷计价）、`cache.ts`（judge/consolidate TTL=0）、`client.ts`（OpenAI 兼容传输层 + MockTransport）、`structured.ts`（校验失败重试 1 次后 `ok:false`，返回成本 meta）、`index.ts`（`createLlm`）
  - `apps/agent`：`triage.ts`（prompt `tp-1.0` + 结构化隔离 + `parseTriage` + 注入嫌疑检测）、`index.ts`（`handleIssueEvent` + `decideActions` 纯函数）
  - 测试：`pnpm test`（vitest，41 用例全绿）；试跑：`pnpm triage:dryrun -- --limit 300`（离线审阅真实 prompt），加 `--call` 真实跑批
- ✅ **golden set 标注全量完成（2026-09-27）**：剩余 224 条由 AI 第 1 轮标注（annotator=ai-v1，8 子代理 + 两轮质检）。终态主标签：bug 104 / question 74 / feature 67 / invalid 36 / duplicate 19（全量 300）；**QA 轨道 127/300 条已产出**（有实质维护者回复才产出，35 条据不足置 null）；token 修复后已拉全维护者回复（252/253）。分诊标签经两轮证据复核共改判 12 条（含 duplicate 原号回填），详见 `docs/annotation-report-ai-r1.md` 与 `datasets/ai-annotation/round1/reviews.json`（15 条待仲裁）
- ✅ **W2 Inbox 已落地（2026-09-27）**：`apps/agent/src/inbox.ts`（eventId 幂等认领、issues/issue_comment 事件映射、1m/5m/30m 重试 + 死信、HMAC 验签）+ `webhook-server.ts`（:8787 HTTP 接入，`pnpm --filter @evokeeper/agent dev`）。队列/存储为接口注入 + 内存实现，装 Redis/PG 后换 BullMQ/Postgres 适配器，接口不变。单测 13 例（去重/重试/映射/验签）
- ✅ **W2 基线跑批完成（2026-09-27）**：tp-1.2 × deepseek-v4-flash × 全量 300 条 → 主标签准确率 **67.0%**（解析失败 22、nmi 命中 1/39 误报 0、成本单条 ¥0.0023、p50 1.6s）。结构性发现：duplicate 召回 0/19（需 W4 RAG 证据，prompt 已冻结禁止调参）；bug↔question 互窜是主要误差源。报告 `datasets/pilot/baseline-deepseek-v4-flash-mc-1.0-tp-1.2-v1-draft-n300.json`，分析记入 design.md §9.1
- ✅ **回答基线补记完成（2026-09-28）**：ap-1.0 × deepseek-v4-pro × 30 条 QA → 30/30 全通、0 解析失败、检索命中 30/30、回答带真实引用 30/30、护栏剥离臆造引用 1 处；单条 ¥0.0128、p50 7.5s / p95 19.4s。**W2 DoD 四项全部达成**（分诊 ✓ 注入防护 ✓ triage 基线 ✓ RAG 问答+基线 ✓）。pilot 脚本已加报告防覆盖（--force 才可覆盖）
- ✅ **W3 存储与判别落地（2026-09-28）**：`packages/memory` 四操作记忆层（ADD/UPDATE 优先/DELETE 软删/NONE + 冲突消解 confidence→证据链 + validUntil 失效 + 切片硬过滤，12 例单测）；`apps/agent/src/trace-store.ts` 轨迹库（buildTrace 装配 + InMemory/JSONL 双实现，inbox 处理完成自动落库 trace id=delivery id）；`apps/worker/src/judge.ts` 判别器 jrv-1.0（优先级命中 + 14 天窗口 + unclear 不进整理管线，11 例单测）。core 的 MemoryItem 补 expectedSlice 字段（design.md v1.4）
- ✅ **W5 睡眠整理管线 v1（2026-09-28）**：`apps/worker/src/consolidate.ts`——runConsolidation：unclear 双保险过滤 → 硬分组（主标签）→ average-linkage 聚类（阈值 0.82，当前 token cosine 相似度，embedding 就绪后注入替换）→ 低频簇记录（不成候选）→ LLM 归纳 cp-1.0 → ExperienceCandidate(proposed) 进人工评审；maxCandidates 预算 + 证据链防御校验；7 例单测。core 的 Trace 补 issueExcerpt（脱敏前 500 字，design.md v1.5）
- ✅ **W6 评测 harness + 门禁判定实现（2026-09-28）**：`packages/eval`——golden set 加载、accuracy + 宏 F1（nmi 附加维度单独报告）、bootstrap 1000 次 CI（seed 确定性）、`evaluateGate` 五条判定 + 前置防御（跨 datasetVersion 拒绝、换模型未重跑基线拒绝）；**skipped 语义裁定**：adversarial W8 前显式 skipped（不阻塞发布但永不计通过），holdout 双跑缺失=显式阻塞。13 例单测。经验 CI/CD 全链路代码贯通：轨迹→判别→整理→候选→门禁
- ✅ **W6 runner / 影子回放 / 发布回滚落地（2026-09-28）**：`eval:run`（golden set → EvalRun，基线 run 已落盘：68.7%、宏F1 0.592、CI95 [63,74]、¥0.57——与 pilot 67.0% 交叉验证吻合）；`eval:gate`（自比演练正确 REJECTED，退出码可挂 CI）；影子回放（第 6 道门禁，一致率阈值 0.95 provisional）；`release.ts`（§8 状态机：R1 禁发 / 无 diff 禁发 / 灰度三态 / O(1) 回滚）。教训：GoldenCase 须带 title/body（首跑空正文全判 invalid，产物作废重跑）。design.md v1.7
- ✅ **工具治理网关落地（2026-09-28）**：`packages/gateway`——幂等键 (repo, issueNumber, actionKind, contentHash) 防 webhook 重放、单次配额（≤2 标签 + ≤1 评论）、同 issue 24h 评论冷却、全量审计留痕；纯函数无 IO（8 例单测）。W4 真实写动作执行器必须经此网关
- ⏳ 待办：① 第二轮盲标 60 条（`ANNOTATE_DATA=datasets/review/blind-round2.jsonl node scripts/annotate.mjs`，annotator 填 v2）→ `node scripts/kappa.mjs` 算 κ≥0.75；② 仲裁 15 条（重点：3 条 duplicate 缺原号、feature/question 边界 2 条）；③ κ 过关 + 仲裁后跑 `node scripts/select-holdout.mjs --apply` 落锁 holdout 40 条（seed=42 可复现，dry-run 默认）→ 落锁后 holdout 只读、门禁演练补 holdout 双跑；④ 装 Docker 后：infra 验证 + Postgres/BullMQ 适配器 + 整理聚类换 embedding + Langfuse 观测；⑤ 真实流量启动：GitHub App 注册（issues:write）→ executeActions 接线上 → 每日 scanReactions cron；⑥ 回答 LLM-judge 五维（等 GLM key）；⑦ apps/web 管理台（轨迹查看/记忆时间线/评测报告/一键回滚）

## 3. 不可违反的项目约定

1. 评测门禁是项目灵魂（计划书红线 R1）：任何经验不经评测不得生效；进度落后也永不砍 W6 门禁；
2. MVP 冻结清单（计划书 §2.3）：不改代码、不发 PR、不做多租户、不做训练；
3. golden set：holdout 锁定永不改；指标禁止跨数据集版本比较；标注一致性 κ≥0.75；
4. Agent 动作白名单：打标签 / 评论 / 转人工，无其他写权限。

## 4. 用户背景（沟通与协作注意）

- 邱伟洪，28 届本科（仲恺农业工程学院·计算机），Java 后端实习（AI 对话后端：三层记忆、事实抽取、群聊分类），目标转全栈 Agent 开发；
- 学习方式：项目驱动；重视论文理论支撑与差异化，反感同质化方案；
- 沟通偏好：直接给判断和依据，不要客套；方案要有第一性原理推导。

## 5. 环境备忘（Windows）

- git 全路径：`C:\Users\lenovo\.workbuddy\binaries\PortableGit\versions\1.2.0\cmd\git.exe`（bash shim PATH 损坏，coreutils 需绝对路径；PowerShell 工具可能不回显 stdout，用 Glob/Read 校验结果）
- 本地服务：`docker compose -f infra/docker-compose.yml up -d`（pgvector:5432 / redis:6379 / langfuse:3000）
- Node 22 + pnpm 9；安装依赖 `pnpm install`（本机 pnpm 需经 corepack：`node <...>/node_modules/corepack/dist/pnpm.js`）
- 测试 `pnpm test`（vitest，根 devDependency）；TS 脚本用 `tsx`（如 `pnpm triage:dryrun`）
- Node 直跑 TS 不可行：相对导入无扩展名会 ERR_MODULE_NOT_FOUND（不启用 `--experimental-strip-types` 直跑）
