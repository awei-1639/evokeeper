# EvoKeeper 会话简报（给未来任何工作区的接续说明）

> 用途：当你（AI 助手）在新的工作区/会话中接到本项目时，先读本文件与 `项目计划书.md`，即可恢复全部上下文。最近更新：2026-10-31。

## 1. 项目一句话

EvoKeeper：挂在开源仓库上的自进化维护者助手 Bot（issue 分诊 + 技术问答），核心是"经验 CI/CD"闭环——轨迹沉淀 → 睡眠式整理 → 候选经验 → 评测门禁 → 版本化灰度发布，越用越准、可审计可回滚。理论锚点：MetaRSI（arXiv:2609.06396）Loop Kernel / Harness-RSI。

## 2. 当前进度（W1-W8 主体完成，进入经验发布攻坚，更新于 2026-10-31）

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
- ✅ **holdout 首评完成（2026-10-17）**：`pnpm eval:run -- --tag=final-holdout --split=holdout --ds=v1` → accuracy **62.5%**（25/40）、宏F1 0.510、CI95 [45.0, 77.5]、nmi 误报 0（命中 0/5）、¥0.13、p50 14.5s。**与 dev 基线 65.0%@160 对比：差 2.5pt 且落在 CI 内 → 泛化成立、无过拟合证据，W6 门禁的统计前提（dev 指标可外推）确认**。错例结构：duplicate 0/3 全错（既有结构性缺口，等 W4 RAG）、bug↔question 混淆 3 条、invalid 混淆 2 条。报告 `datasets/eval/run-final-holdout-holdout-deepseek-v4-flash-mc-1.0-v1.json`。**通道说明**：本次经公益站（xxs.l.cd）执行——模型字符串 deepseek-v4-flash 与 mc-1.0 一致，且事先以 fidelity-check 40 条验证通道行为等价（有效 35 条预测一致 91% ≥ 90% 门槛，详见 2026-10-17 会话记录）；holdout 此后只读，永不重评。
- ✅ **W4 端到端打通（2026-10-25）**：GitHub App 认证与真实写动作接线（`github-client` + 网关治理）、`bot-up` 一键拉起（清残留 + 服务 + cloudflared 隧道 + webhook URL 回填 + 公网探活）、问答链路上线 + 轨迹重放器、`scan:daily` 线上适配；**真实流量分诊首次生效**，写动作审计落 `datasets/gateway/audit.jsonl`
- ✅ **经验闭环首次完整转通 + 门禁实战（2026-10-25/26）**：整理管线产出 2 条候选，**全部 REJECTED**——① skill（question 泛化）72.5%→71.3%、修 5 破 7、成本 +17%；② 检索证据注入 72.5%→69.4%，宏F1 +0.063、dup 召回 0/10→3/10（**机制有效**）但成本 **+145%** 触硬上限；第三条路线（BM25 轻量证据）持平。R1 首次以数据否决真实候选，不是形式主义
- ✅ **数据集 v2（2026-10-26）**：v1 全量 + expansion 100 入 dev = **260 条**（holdout 40 条锁定不变），CI95 由 ±7pt 收到 ±5.5pt；v2 base 72.7% → tp-1.4d2 74.2%（+1.54pt）。仲裁 15 条清零（9 维持 4 改判）
- ✅ **门禁第 2 条口径修复（2026-10-31）**：`ci95_lower_bound_gt_0` 原用候选 run 的**绝对准确率 CI**（准确率 0.6+ → 下界恒正），自 v1.6 起从未生效。改为 **Δ 配对 bootstrap**（`pairedDeltaCI95`，按 caseId 对齐，覆盖率 ≥80% / ≥20 条）。**回溯 6 组历史对照，Δ CI 全部跨 0** → tp-1.4 的 +1.88pt 是噪声（此前误读为"真实小增益"，已纠正），根因是统计功效不足（n=254 时 Δ CI 半宽 ≈3.1pt，要检出 2pt 需 n≈650 或多次采样）。详见 design.md §7.2 v1.19 + `scripts/gate-recheck.mts`
- ✅ **环境恢复（2026-10-31）**：pg 停 4 天导致 langfuse 陷入 6021 次重启循环；拉起 pg 后 langfuse health=200，pgvector 0.8.5 + issue_docs 300 条向量完好。**全量 216/216 通过（真容器，零 skip）**，typecheck 8 包全绿
- ✅ **通道切换 mc-1.3（2026-10-31 晚）**：xxs 站三条 chat 路径全断（v4-flash `503` 无渠道 / gpt-6-luna `500`→`400 unknown provider`），官方端点对本站 key 回 `401 Authentication Fails`——**不是余额问题，此前"DeepSeek 官方余额耗尽"的判断是错的，已纠正**。triage 改走 SiliconFlow 的 `deepseek-ai/DeepSeek-V4-Flash`（**同一底层模型，换通道不换模型**）：fidelity 40 条 **32/35 = 91%** 过 90% 线，对 gold 72.5% vs 官方同 40 条 67.5%（n=40 不显著）。计价：低谷（02:00–08:00）与官方同价 ¥1.5/¥4.5，其余时段翻倍，**时段划分与官方不同**。改动 `packages/llm/src/config.ts`（version mc-1.3 + MODEL_SPECS 新条目）；两处硬编码模型名的测试已改为 `resolveModel("triage")` 跟随路由
- ✅ **评测上限诊断（2026-10-31，design.md §7.3）**：三个零成本探针证伪三条路线——① **duplicate 纯相似度不可分**（最优 F1 0.281 @τ=0.79，precision 18.8%；invalid 组相似度中位数 0.777 反超 duplicate），说明「注入证据判 duplicate」的成本墙背后是**判据本身无效**；② **needs-more-info 不可学**（nmi 组文本信息完整度反比对照组高 13.2pt、版本号 +36pt）——gold nmi 是「维护者追问过」的事件标注，0/33 不是模型缺陷；③ **k 采样降噪已实测否决**（当日晚，24 条 = 12 错 + 12 对，k=5 temp=0.8，¥0.373）：分歧率仅 **12.5%**，**多数票准确率 58.3% 与单次 58.3% 完全持平（净 0pt）**→ 方案② 毙掉。探针初版判据「修正>破坏」曾把**通道差异**误判成采样收益（gs-0011 五次全 `bug` 无分歧，被记为"被多数票修正"，实为官方 question → SiliconFlow bug），已改为「多数票 vs 单次准确率」直比 + 无分歧却与基线不同者单列 `channelDiff`。
- ✅ **战略结论**：给 title+body 的输入下 75% 已接近上限，剩余错误主要依赖维护者行为。**主指标应从标签 accuracy 转向动作质量**（escalate 精度 / 请求补充信息的正确率 / 评论被接受率），可被 `ReactionSignal` 自监督且效应量 10pt 级——这是唯一能绕开「统计功效 + 成本墙」双约束的方向。**采样的正确用法随之改变**：不用来投票（已证伪），而用其**分歧度作不确定性信号**触发 escalate——实测分歧全部落在错例区（错例 3/12 vs 对例 0/12），且该信号不依赖 gold 标注
- ⚠️ **未推送**：本地 `master` 领先 origin 24+ 提交（远端停在 10-18 的 `fb04e09`），需用户显式指令再 push
- ⏳ 待办（按优先级）：① **动作质量指标定义 + 基线采集**（现在 `datasets/judged` 只有 4 条自测轨迹，需真实流量积累；可先把 escalate 触发条件从"置信度阈值"改为"采样分歧度"并离线验证）；② 回答 LLM-judge 五维（等 GLM key）；③ 管理台回滚按钮（等首个成功发布）；④ Langfuse 建组织拿 key 填 `.env.local`；⑤ 若要继续在标签准确率上做门禁，**唯一出路是扩 dev 到 650**（方案② 已否决）。已清旧账：仲裁 15 条清零、Docker 适配器接线、GitHub App 上线、tp-1.3 检索 A/B、门禁口径修复、采样探针实测

## 3. 不可违反的项目约定

1. 评测门禁是项目灵魂（计划书红线 R1）：任何经验不经评测不得生效；进度落后也永不砍 W6 门禁；
2. MVP 冻结清单（计划书 §2.3）：不改代码、不发 PR、不做多租户、不做训练；
3. golden set：holdout 锁定永不改；指标禁止跨数据集版本比较；标注一致性 κ≥0.75；
4. Agent 动作白名单：打标签 / 评论 / 转人工，无其他写权限。

## 4. 用户背景（沟通与协作注意）

- 邱伟洪，28 届本科（仲恺农业工程学院·计算机），Java 后端实习（AI 对话后端：三层记忆、事实抽取、群聊分类），目标转全栈 Agent 开发；
- 学习方式：项目驱动；重视论文理论支撑与差异化，反感同质化方案；
- 沟通偏好：直接给判断和依据，不要客套；方案要有第一性原理推导。

## 5. 环境备忘（Windows，2026-10-31 实测）

- git 全路径：`C:\Users\lenovo\.workbuddy\binaries\PortableGit\versions\1.3.0\cmd\git.exe`（**版本号会随工具升级变化**，找不到时先 `ls` versions/ 目录；/mingw64/bin/git 亦可用）
- pnpm：**`/d/Nodejs/pnpm` 可直接调用**（旧的 corepack 路径已失效，别再照抄）
- 本地服务：`docker compose -f infra/docker-compose.yml up -d`（pgvector:5432 / redis:6379 / langfuse:3001→3000）；只装在 WSL2 内，Windows 侧 `docker` 命令不存在 → 用 `wsl -e docker ps`
- **容器会随 WSL VM 空闲回收而停**：pg 一停，langfuse 就连不上库、陷入无限重启（实测累计 6021 次）。症状是 langfuse 一直 Restarting + 集成测试静默 skip。修法：`wsl -e docker start evokeeper-postgres` → `wsl -e docker restart evokeeper-langfuse`
- 集成测试要显式传容器地址（vitest 不读 .env.local）：`DATABASE_URL="postgresql://evokeeper:<compose 里的密码>@localhost:5433/evokeeper" REDIS_URL="redis://localhost:6379" pnpm test` → 216/216 零 skip（密码见 `infra/docker-compose.yml`，勿复制进文档）
- **pg 端口现在是 5433**（2026-10-31）：5432 被另一个项目的 `tutor-postgres` 占用，`docker start` 会报 `port is already allocated`。compose 已改为 `${EVOKEEPER_PG_PORT:-5432}:5432`，本机用 `EVOKEEPER_PG_PORT=5433 docker compose -f infra/docker-compose.yml up -d --force-recreate postgres` 起在 5433；`.env.local` 的 DATABASE_URL 同步改 5433。**别去停 tutor-postgres**（那是另一个活跃项目）
- **系统 HTTPS_PROXY 会毒化所有 LLM 调用**：当前环境变量指向 `127.0.0.1:61926`（Clash 重启后已失效），而 `client.ts` 会读它并用 ProxyAgent → 请求全部失败且报错含糊（`curl code=000` / `SSL connect error`）。实测 xxs 与 SiliconFlow **均可直连**，跑任何脚本前先 `HTTPS_PROXY= HTTP_PROXY= https_proxy= http_proxy= pnpm exec tsx ...`
- Node 直跑 TS 不可行：相对导入无扩展名会 ERR_MODULE_NOT_FOUND；TS 脚本一律走 `pnpm exec tsx`
- **坑**：Git Bash 下把 `/dev/null` 传给 wsl 会被 MSYS 路径转换成本地文件 `nul`（Windows 保留名，safe-delete 删不掉，需 `wsl -e rm /mnt/d/...` 清理）。探活改用 `-o /tmp/x` 或直接在 WSL 里跑
