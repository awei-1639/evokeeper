# EvoKeeper

> 自进化开源社区助手 —— 一个挂在开源仓库上的维护者助手 Bot：自动分诊 issue、回答技术问题，并且每次答错都会被记录、离线归纳为经验、通过评测门禁后以新版本上线，从而"越用越准"，全程可审计、可回滚。

参考 [MetaRSI (arXiv:2609.06396)](https://arxiv.org/abs/2609.06396) 的 Loop Kernel 范式与 AWM / Mem0 / Voyager 等研究，把"经验积累"工程化为一套带评测门禁的发布流程（经验 CI/CD）。

完整设计见《项目计划书》（`docs/项目计划书.md`）。

## 架构总览

```
┌──────────────────────────────────────────────────────┐
│ 用户面：GitHub App（webhook）                          │
│  issue opened / commented → 事件入队                    │
├──────────────────────────────────────────────────────┤
│ 核心引擎（场景无关，项目本体）                           │
│  Agent执行器 → 轨迹库                                   │
│      → 睡眠整理(离线) → 候选经验 → 评测门禁 → 版本化发布   │
│  支撑：记忆层(4类) · MCP工具治理网关 · LLM路由与成本结算    │
├──────────────────────────────────────────────────────┤
│ 管理台：Next.js（轨迹查看器 / 记忆时间线 / 评测报告 / 回滚）│
└──────────────────────────────────────────────────────┘
```

## 目录结构

```
apps/
  agent/    Agent 服务（消费事件、执行分诊与问答）
  worker/   睡眠整理、评测、灰度发布等定时/后台任务
  web/      Next.js 管理台
packages/
  core/     领域模型与类型（轨迹、经验、版本、评测）
  memory/   四类记忆分层（情景/语义/技能/偏好）
  eval/     评测 harness（golden set 加载、指标、门禁判定）
  gateway/  MCP 工具治理网关（权限/审计/限流）
  llm/      模型分级路由与 usage 成本结算
datasets/   golden set / holdout（JSONL，进 git）
docs/       标注规范、论文精读指南、进化周报
infra/      docker-compose（Postgres+pgvector / Redis / Langfuse）
```

## 快速开始

```bash
# 1. 依赖（需要 Node 22+ 与 pnpm 9+）
pnpm install

# 2. 本地基础设施（Postgres / Redis / Langfuse）
docker compose -f infra/docker-compose.yml up -d

# 3. 启动开发
pnpm -r dev
```

## 当前状态（对照计划书 W1-W10）

- [x] Monorepo 骨架 + 领域类型定义（packages/core）
- [ ] golden set v1 ≥ 150 条（标注规范见 docs/annotation-guideline.md）
- [ ] 静态 Agent v1（分诊 + RAG 问答）
- [ ] 轨迹库 / 记忆层 / LLM 路由
- [ ] 睡眠整理 + 评测门禁 + 版本化发布（W6 关键里程碑）
- [ ] 管理台 v1
- [ ] 对抗评测 + MCP 网关
- [ ] 开源发布

## 设计红线（先于一切功能）

1. **R1** 没有评测门禁的进化 = 随机漂移，任何经验禁止直接生效；
2. **R2** Agent 只有最小写权限（评论 / 打标签），禁止改代码、禁止发 PR；
3. **R3** 每次行为必须留痕（轨迹 + 成本 + 版本号），否则无法归因与回滚。
