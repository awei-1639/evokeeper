# EvoKeeper

> 自进化开源社区助手 —— 一个挂在开源仓库上的维护者助手 Bot：自动分诊 issue、回答技术问题，并且每次答错都会被记录、离线归纳为经验、通过评测门禁后以新版本上线，从而"越用越准"，全程可审计、可回滚。

参考 [MetaRSI (arXiv:2609.06396)](https://arxiv.org/abs/2609.06396) 的 Loop Kernel 范式与 AWM / Mem0 / Voyager 等研究，把"经验积累"工程化为一套带评测门禁的发布流程（经验 CI/CD）。

完整设计见《项目计划书》（`docs/项目计划书.md`）与《系统设计说明书》（`docs/design.md` v1.10）。

## 架构总览

```
┌──────────────────────────────────────────────────────┐
│ 用户面：GitHub App (webhook)                          │
│  issue opened / commented → Inbox（eventId 幂等去重）  │
├──────────────────────────────────────────────────────┤
│ 核心引擎（场景无关，项目本体）                          │
│  Agent执行器 → 轨迹库（TraceStore，成功失败都落库）      │
│      → 失败判别(judgeTrace) → 反应信号采集（每日扫描）   │
│      → 睡眠整理(离线) → 候选经验 → 评测门禁 → 版本化发布  │
│  支撑：记忆层(4类·四操作) · 工具治理网关 · LLM路由与结算  │
├──────────────────────────────────────────────────────┤
│ 管理台：Next.js（概览/评测报告/轨迹/Golden/仲裁/发布）    │
└──────────────────────────────────────────────────────┘
```

## 目录结构

```
apps/
  agent/    Agent 服务（分诊 tp-1.2 + RAG 回答 ap-1.0 + Inbox + GitHub 执行器）
  worker/   失败判别器(jrv-1.0) + 睡眠整理 + 影子回放 + 发布回滚状态机
  web/      Next.js 管理台 v1（七页只读）
packages/
  core/     领域模型与类型（轨迹、记忆、经验、门禁——单一事实来源）
  memory/   四类记忆分层（四操作判定：ADD/UPDATE/DELETE/NONE）
  eval/     评测 harness（指标 + bootstrap CI + 门禁五条判定）
  gateway/  工具治理网关（幂等键/限流/冷却/审计，可独立开源）
  llm/      模型分级路由与 usage 成本结算（峰谷计价）
datasets/   golden set（300 条全标注）/ QA（127）/ 对抗集（30）/ 评测报告（进 git）
docs/       计划书、design.md、标注规范、论文精读、标注报告
infra/      docker-compose（Postgres+pgvector / Redis / Langfuse）
scripts/    fetch/annotate/eval/gate/holdout/kappa 等工具链
```

## 快速开始

```bash
# 1. 依赖（需要 Node 22+ 与 pnpm 9+）
pnpm install

# 2. 分诊离线演练（不联网，审阅真实提示词）
pnpm triage:dryrun -- --limit 20

# 3. 评测与门禁（需要 .env.local 配 DEEPSEEK_API_KEY）
pnpm eval:run -- --tag=baseline --split=dev --ds=v1-draft-n300
pnpm eval:gate -- --baseline=datasets/eval/run-baseline-...json --candidate=...

# 4. 标注工具（浏览器标注 / 盲标复标）
node scripts/annotate.mjs                       # 默认草稿池
ANNOTATE_DATA=datasets/review/blind-round2.jsonl node scripts/annotate.mjs  # 盲标子集
node scripts/kappa.mjs                          # 一致性检验（κ≥0.75 达标）

# 5. 管理台
pnpm --filter @evokeeper/web dev                # → http://localhost:3000

# 6. 真实 webhook 接入（需 GITHUB_WEBHOOK_SECRET）
pnpm --filter @evokeeper/agent dev              # → http://localhost:8787/webhook
```

## 当前状态（对照计划书 W1-W10）

- [x] Monorepo 骨架 + 领域类型（packages/core）
- [x] golden set 300 条分诊标注全量（人工 v1 × 76 + AI ai-v1 × 224，两轮质检）；QA 127 条
- [x] 静态 Agent v1：分诊基线 **68.7%**（tp-1.2 × deepseek-v4-flash，¥0.0019/条）+ RAG 回答基线
- [x] 轨迹库 / 记忆层四操作 / 失败判别器 jrv-1.0 / 工具治理网关
- [x] 睡眠整理管线 v1（聚类 + 归纳）+ 评测门禁五条 + 影子回放 + 发布回滚状态机
- [x] 对抗样本集 30 条（防线实测 30/30 通过）
- [x] 管理台 v1（七页只读）
- [ ] **第二轮盲标 60 条 → κ≥0.75 → holdout 40 条落锁**（门禁可信的前提）
- [ ] 真实流量（GitHub App 注册 + 部署）→ 影子回放真实数据 → 第一个经验发布（W6 里程碑）
- [ ] Postgres/BullMQ/Langfuse 适配器（等 Docker infra）

## 设计红线（先于一切功能）

1. **R1** 没有评测门禁的进化 = 随机漂移，任何经验禁止直接生效；
2. **R2** Agent 只有最小写权限（评论 / 打标签），禁止改代码、禁止发 PR；
3. **R3** 每次行为必须留痕（轨迹 + 成本 + 版本号），否则无法归因与回滚。
