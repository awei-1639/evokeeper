# EvoKeeper 会话简报（给未来任何工作区的接续说明）

> 用途：当你（AI 助手）在新的工作区/会话中接到本项目时，先读本文件与 `项目计划书.md`，即可恢复全部上下文。最近更新：2026-09-13。

## 1. 项目一句话

EvoKeeper：挂在开源仓库上的自进化维护者助手 Bot（issue 分诊 + 技术问答），核心是"经验 CI/CD"闭环——轨迹沉淀 → 睡眠式整理 → 候选经验 → 评测门禁 → 版本化灰度发布，越用越准、可审计可回滚。理论锚点：MetaRSI（arXiv:2609.06396）Loop Kernel / Harness-RSI。

## 2. 当前进度（W1 进行中）

- ✅ pnpm monorepo 脚手架（apps: agent/worker/web 占位；packages/core 已有完整领域类型）
- ✅ golden set 标注规范 `docs/annotation-guideline.md` + 示例数据 `datasets/examples/`
- ✅ W1 论文精读指南 `docs/papers/W1-reading-guide.md`（MetaRSI/AWM/Voyager/Reflexion/Mem0）
- ✅ git 首提交 0ce4ea3
- ⏳ 待办：精读 5 篇论文并产出 docs/design-notes.md；选定主仓库并标注 golden set v1 ≥150 条；本地 pnpm install + docker compose 验证

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
- Node 22 + pnpm 9；安装依赖 `pnpm install`
