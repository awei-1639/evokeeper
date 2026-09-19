# W1 设计笔记（design-notes）

> 本文是**研究向**文档：记录 5 篇论文如何推导成设计决策（Why 的依据）。工程落地规格（分层、链路、模块契约、门禁算法、工程规范）见 **`docs/design.md`**；战略与排期见 `docs/项目计划书.md`。

> 按 `docs/papers/W1-reading-guide.md` 要求产出：5 个设计决策（注明来源论文）、Loop Kernel ↔ EvoKeeper 映射表、睡眠整理流程草图、技能文件格式草案、记忆写路径设计、MetaRSI 可用/不可用判断清单。
> 核验说明：5 篇论文的 arXiv 摘要已于 2026-09-13 在线核验（MetaRSI=2609.06396 v2 / AWM=2409.07429 / Voyager=2305.16291 v2 / Reflexion=2303.11366 v4 / Mem0=2504.19413）。MetaRSI 未经同行评议（提交于 2026-09-06，v2 修订于 09-09），全文精读时若发现与摘要表述有出入，以全文为准回改本文件。

---

## 0. Loop Kernel ↔ EvoKeeper 映射表

MetaRSI 把自我改进统一为"反馈 → 学习信号 → 改动 → 验证 → 回流"的 Loop Kernel。EvoKeeper 的模块与之一一对应（这一步在写任何代码之前钉死，防止模块职责漂移）：

| Loop Kernel 环节 | EvoKeeper 落点 | 状态 |
|---|---|---|
| 反馈 Feedback | `ReactionSignal` → 失败判别 → `JudgedTrace.verdict`（显式失败/隐式失败/unclear 三级） | W3 |
| 学习信号 Learning signal | sleep-consolidator：失败轨迹聚类 → 模式归纳（embedding + 规则） | W5 |
| 改动 Proposal | `ExperienceCandidate`（4 类型：skill / prompt_patch / memory_update / tool_request，强制携带 evidenceTraceIds） | W5 |
| 验证 Verify | eval-gate：golden set dev+holdout 双跑 → bootstrap 95% CI → `GateDecision` 五规则全过才放行 | W6（灵魂） |
| 回流 Integrate | release-manager：版本化 diff → 灰度 48h → 全量/一键回滚 → 写回 Harness 槽位 | W6 |
| 元层 Meta | 进化周报 + 每周人工抽检 20 条校准 judge 与标注规范（判别器本身也要被评测） | W4 起 |

**v1 开放的 Harness 槽位清单（决定，见 D1）**：Skill + Memory + Prompt 三个槽位可写；MCP/Tools 槽位冻结（工具集固定为"读公开数据 / 写评论 / 打标签"三类，只允许 `tool_request` 登记缺失，不自动新增）。

---

## 1. 五个设计决策

### D1 经验变更 = 槽位编辑，且必须过验证器（来源：MetaRSI 摘要 §Harness-RSI 与 "refutable laws"）

MetaRSI 的 Harness-RSI 定义了"不动权重、编辑五槽位 scaffold（Prompt/Skill/MCP/Tools/Memory）"的改进路线；其定律"验证器决定自我改进的边界"（Law 1，正文精读待核对编号）直接推导出我们的红线 R1。

**决策**：
1. v1 只开放 Skill / Memory / Prompt 三槽位；MCP/Tools 冻结。理由：槽位越少，评测面越小，门禁越可信（这是 Law 1 的工程推论：验证器只能裁决它能重放的行为）；
2. `ExperienceCandidate.status` 的状态机 `proposed → evaluating → approved/rejected → released` 不可跳步；`released` 必须引用 `gateDecisionId`，`ReleaseVersion.diff` 必须可回放——没有 diff 快照的发布一律拒绝落库；
3. Agent 执行器读到的 Harness 内容必须携带版本号进 Trace（R3），否则回滚无法归因。

### D2 睡眠整理：轨迹级 + 步骤级双粒度归纳，≥3 次才成候选（来源：AWM 摘要与归纳机制）

AWM 证明从历史轨迹离线归纳 workflow、再注入后续任务可大幅提分（Mind2Web +24.6%、WebArena +51.1% 相对成功率；分布偏移下仍 +8.9~14.0 绝对点），且分 offline（训练集预先归纳）/ online（测试时即时归纳）两种。它归纳的对象是"高频复用的子任务级例程"。

**决策**（对照 AWM 的三点差异化）：
1. 聚类粒度取双轨：trajectory-level（整次分诊/问答的失败模式）+ step-level（某个可复用片段，如"检查 npm 缓存"）；中文社区 issue 的失败模式粒度比 web navigation 更细，纯 trajectory 级会漏；
2. 触发阈值：同一 `expectedSlice` 内同聚类失败 ≥3 次才生成候选——AWM 无此阈值，它靠人筛；我们没有人工筛选预算，用阈值 + 证据链强制替代；
3. AWM 只归纳成功轨迹；我们失败与成功双通道（失败 → 补丁型经验，成功 → 放大型技能），但两者的候选都必须过同一个门禁，防"成功经验被盲目放大"。

### D3 技能记忆 = 带 frontmatter 的 .md + embedding 检索键（来源：Voyager 技能库）

Voyager 的技能库把"描述（检索键）— 可执行内容 — 复杂度递增"做成持续生长的结构（3.3x 独特物品、15.3x 加速科技树），核心可迁移点是**描述与内容分离**。

**决策**（自然语言场景对 Voyager 的改造）：
1. 技能存 `.md` 而非代码（我们不改代码、技能面向 LLM 消费）；frontmatter 承担 Voyager 的 description 角色：`id / description / tags / expectedSlice / version / evidenceRefs / createdAt / validUntil`；
2. 检索键 = embedding(description) + tags/expectedSlice 硬过滤；检索结果按"最小上下文原则"只注入技能正文结论，不注入归纳过程；
3. 采纳 Voyager 自动课程思想的弱化版：整理器每周按"失败频次 × 可判定性"排序优先归纳哪类失败——可判定性低的（纯情绪/政治类）永远排在后面。

### D4 失败判别 = 有噪声的语言信号分级，判别器自身要校准（来源：Reflexion）

Reflexion 证明不更新权重、只靠语言化反思进 episodic buffer 也能显著提分（HumanEval pass@1 91% vs GPT-4 80%）。它有明确的 Evaluator（测试通过与否）；我们没有等强度的信号——issue 场景的"失败"只能靠维护者行为推断。

**决策**：
1. 反应信号分级沿用计划书 §5.1 并细化判别规则 v1：显式失败（维护者改标签/重开/纠正评论）> 隐式失败（作者追问 ≥2 次且未采纳后弃用）> success（作者感谢/作者关闭）> unclear（无反应，默认不进整理管线——Reflexion 的教训是**噪声反思比没有反思更糟**）；
2. Reflexion 论文明确指出反思 buffer 无限增长会被矛盾建议淹没 → 我们的记忆条目必须支持 UPDATE/归并（见 D5），且 `JudgedTrace.judgeRuleVersion` 强制留痕，每周人工抽检 20 条重标校准——判别规则本身是被评测对象；
3. 不做"执行中反思"（Reflexion 是 trial-and-error 场景），反思全部发生在离线整理阶段（睡眠整理），生产路径零风险。

### D5 记忆写路径 = 在线四操作 + 离线归纳两层并存（来源：Mem0）

Mem0 的生产级方案：从对话增量抽取候选记忆 → LLM 判定 ADD/UPDATE/DELETE/NOOP 四操作；LoCoMo 上 LLM-judge 相对 OpenAI +26%，p95 延迟 -91%、token 成本 -90%（靠只处理增量 + 批处理，不重扫全量历史）。图变体（Mem0-g）再 +2%。

**决策**：
1. 两层分工：**在线层**（W3，Mem0 式）从单次对话/issue 交互增量抽取单条事实，四操作判定后写入记忆；**离线层**（W5）跨轨迹归纳模式产出 ExperienceCandidate。对应阅读指南预期："Mem0 在线抽单条事实，我们离线归纳跨轨迹模式——两层并存"；
2. 四操作判定规则 v1：新事实且无冲突 → ADD；与既有条目同一实体且更新 → UPDATE（保留 evidenceRefs 追加）；事实失效（如版本废弃）→ DELETE 软删（validUntil 截止）；无信息量 → NONE。UPDATE 优先于 ADD（直接回应 Reflexion 的 buffer 膨胀教训）；
3. 延迟/成本工程照抄 Mem0 思路：llm-router 的查询级缓存键 = (purpose, 归一化输入)；整理批任务全量批处理不逐条调用；v1 不做图记忆（Mem0-g 的 +2% 换一个图数据库运维成本，在单仓库场景不划算，列入"若记忆检索消融实验需要再启用"——对应选读 HippoRAG 2）。

---

## 2. 睡眠整理流程草图（W5 实现，先行钉死接口）

```
[轨迹库] --每周 cron--> 抽取新 JudgedTrace (verdict != unclear)
        |
        v
[聚类] embedding(轨迹摘要 + issue 文本) + 规则特征(expectedSlice / 标签 / 错误类型)
        |
        v
[过滤] 聚类内 trace 数 >= 3 ?  --否--> 丢弃（记入周报"未成候选的低频簇"）
        |是
        v
[LLM 归纳] purpose=consolidate（强模型）
        输入：聚类代表轨迹（脱敏摘要）+ 对应成功案例（对照）
        输出：ExperienceCandidate{ type, pattern, content, expectedSlice,
               evidenceTraceIds[] (强制), confidence }
        |                                        |
        v                                        v
  type=skill --> 按草稿格式落 skills/     其余 --> 候选池(人工评审队列)
        |                                        |
        +---------------- 均进入 eval-gate 队列 --+
```

## 3. 技能文件格式草案（procedural memory）

```markdown
---
id: skill-0007
version: 2
description: "构建类报错先查缓存损坏与文件截断两类原因"   # 检索键，embedding 输入
tags: [build-error, cache]
expectedSlice: "labels=bug & topic=build-error"
evidenceRefs: ["trace-xxx", "trace-yyy", "issue#102"]
validUntil: null          # 语义过期时由 UPDATE/DELETE 维护
createdAt: 2026-10-10
---

## 适用判断
issue 含构建/运行报错且未给出环境信息时。

## 步骤
1. 要求补充最小复现（版本 / 命令 / 完整报错）；
2. 先答缓存损坏一类原因并给出清理命令；
3. 仍复现则请对方附 go version 等环境信息。

## 反例
纯抱怨无细节 → 走 needs-more-info，不走本技能。
```

## 4. 记忆写路径设计（W3 实现）

```
在线层（单次交互内，Mem0 式）
  对话/issue 交互 --> 抽取器(purpose=answer 副产物, 便宜模型)
      候选事实 --> 与既有记忆检索比对 -->
        四操作判定(ADD / UPDATE / DELETE / NONE, LLM 结构化输出)
      --> 写入 memory_items（kind + confidence + validUntil + evidenceRefs）

离线层（睡眠整理，W5）
  跨轨迹聚类归纳 --> ExperienceCandidate --> 评测门禁 --> 版本化发布
  （离线层产出的 memory_update 类型候选通过门禁后，回放执行同样的四操作写入）

一致性约束：
  - 同一实体事实以 confidence 高者为准；并列时取证据链更长者；
  - 语义记忆必带 validUntil 或"复核日期"；技能记忆版本化走 ReleaseVersion；
  - 最小上下文：检索注入只带业务结论，不带推理过程（R3 审计靠 Trace，不靠记忆）。
```

## 5. MetaRSI 可用 / 不可用判断清单

**采纳为设计语言**（做结构参照，不引用其结论）：
1. Loop Kernel 五环节 + 三算子（Data/Harness/Model）统一词汇表 —— 本文件 §0 映射表的骨架；
2. Harness-RSI 五槽位定义（Prompt/Skill/MCP/Tools/Memory）—— 决定 v1 槽位开放范围（D1）；
3. "验证器决定自我改进边界"与"可信度由不可写表面衡量"两条定律的**思想** —— 推导红线 R1 与灰度设计；
4. "RSI 长期只在机器可验证切片被验证"这一动机陈述 —— 正是本项目在真实社区场景验证 Harness 路线的立论基础。

**不用 / 标记为未验证**（不当结论引用）：
1. two-axis optimizer 与 meta-level policy —— 论文仅在 code + closed-form science 基准验证，社区问答场景无对应实验，v1 不引入元层自动调参，元层只做"周报 + 人工修订"；
2. Model-RSI —— 我们不做训练（A5 + MVP 冻结）；
3. 论文全部数字结论 —— 未经同行评议（2026-09-06 v1 / 09-09 v2），且摘要未给出跨域数字；面试引用时只谈框架不谈数字；
4. Data-RSI 的具体算子实现 —— 与我们的 golden set 建设重叠但路径不同（我们人工标注 + 真实 issue，非模型自产数据），仅借鉴"数据面是共享基底"的定位。

---

## 6. 对既有设计的修订意见（本轮精读的唯一回改点）

计划书 §5.1 失败判别增加一条：**unclear（无反应）轨迹默认不进整理管线**，只进周报的"低信号池"供人工抽样。理由：Reflexion 证明噪声反思有害；无反应 ≠ 失败也不 ≈ 成功，把它当失败会污染归纳方向（风险登记册第 2 条"判错当失败"的低成本缓解）。此条待下一次计划书周复盘时并入正文。
