# Golden Set AI 第 1 轮标注报告（annotator=ai-v1）

> 日期：2026-09-27。范围：`datasets/drafts/alibaba_nacos.jsonl` 中剩余 224 条未标注 issue 的分诊标注（labels_gold / triage_rationale / difficulty）。
> 执行：ZCode（GLM）主导 + 8 个并行标注子代理 + 亲自逐条质检裁决。规范依据 `docs/annotation-guideline.md` v1.0。

## 1. 结果速览

- 数据集 300 条现全部有分诊标签：人工 v1 76 条（gs-0001–gs-0076）+ AI ai-v1 224 条（gs-0077–gs-0300）。
- AI 轮主标签终态（含两轮质检改判）：bug 74 / question 57 / feature 50 / invalid 29 / duplicate 14；needs-more-info 附加 33 条。
- 全量 300 条主标签：bug 104 / question 74 / feature 67 / invalid 36 / duplicate 19，difficulty easy 110 / medium 162 / hard 28。
- QA（回答评测轨道）：全量 127/300 条有 `qa`（人工 2 + AI 125），集中在有实质维护者回复的 question/bug/feature 类。
- **数据集尚未定稿**：κ≥0.75 的一致性检验未做（见 §5），holdout 未锁定，`datasetVersion` 未打 tag。

| 主标签 | 人工 76 条 | AI 224 条（终态） |
|---|---|---|
| bug | 39.5% | 33.0% |
| question | 22.4% | 25.4% |
| feature | 22.4% | 22.3% |
| invalid | 9.2% | 12.9% |
| duplicate | 6.6% | 6.3% |

分布形态接近（人工池是回复丰富的精选子集，AI 池含全部 spam/过期样本，invalid 略高符合预期）。

## 2. 标注方法（可复现）

1. 校准：从人工 76 条中取 14 个判例（含 spam→bug 推翻、wontfix→feature、按设计工作→invalid 等"内容优先"先例）+ 任务书 `datasets/ai-annotation/round1/CALIBRATION.md`。
2. 批量：224 条按文件序均分 8 批（`round1/batch-0*.jsonl`），8 个子代理独立标注，输出 `round1/out-batch-0*.jsonl`，不确定条目自加 `review` 标记。
3. 合并校验：schema/枚举/主标签互斥/覆盖率全查（224/224 覆盖，0 冲突 0 缺失）后才写回主文件；id 按 `gs-0077..gs-0300` 文件序分配，`split` 全部保持 `dev`，`annotator=ai-v1`，`annotated_at=2026-09-27`。

**协议差异（已部分消解）**：首轮标注时 `GITHUB_TOKEN` 已失效（401），AI 224 条在**无维护者回复**参照下完成；人工 76 条中 47 条有回复参照。token 刷新后已重跑 `scripts/fetch-maintainer-replies.mjs --all`（252/253 成功，仅 gs-0045/#14437 因网络瞬断无回复），AI 224 条中 199 条现已有回复数据，并据此做了第二轮证据复核（§3.2）。QA 轨道也据此完成（§4）。

## 3. 质检与裁决记录

三层质检：① 子代理自标 review（25 条）→ ② AI 判定 vs 维护者标签冲突扫描（15 条）→ ③ ZCode 逐条亲读 21 条原文裁决。

**改判 2 条**（理由已写入主文件 triage_rationale）：

| id | issue | 原判 | 改判 | 依据 |
|---|---|---|---|---|
| gs-0095 | #14451 | invalid | question | 正文是"请教有无坑"的咨询口吻，无缺陷证据；维护者 status/invalid 系"无影响"的结论而非内容无效 |
| gs-0120 | #14642 | feature | bug | Agent 注册失败附完整堆栈，预期 vs 实际明确；kind/enhancement 系把注册视为新特性，不改变缺陷性质 |

**维持 19 条**（典型：#15599 kind/question 但正文有明确"预期行为"描述判 bug；#15728 spam 标签被正文完整缺陷报告推翻，沿 gs-0006 先例；#13835 wontfix+question 但 API 返回缺 content 属明确缺陷）。

**待人工仲裁 15 条**（`datasets/ai-annotation/round1/reviews.json` 有逐条原因，其中 10 条已据回复证据裁决）。剩余重点：gs-0133/#14963、gs-0182/#15151、gs-0230/#15159 三条 duplicate 维护者只说"duplicate"未给原号（按人工 gs-0060 先例保留，检索未找到唯一可信原号，未硬填）；gs-0253/#14492 已按回复回填关联 #13273；gs-0106/#14111（feature 与 question 边界）、gs-0272/#14415（新版本已实现该能力）等建议人工过目。

### 3.2 回复证据复核（2026-09-27 第二轮，token 修复后）

维护者回复抓取完成后，对 25 条 review 标记 + duplicate 信号全量扫描做了带证据重审：

**据回复改判 10 条、回填 2 条**：

| id | issue | 原判 → 终判 | 证据（维护者回复） |
|---|---|---|---|
| gs-0101 | #15704 | question → duplicate | "dupilicate with #15708" |
| gs-0163 | #13887 | feature → duplicate | "duplicated with #5797" |
| gs-0225 | #14053 | feature → duplicate | 按贡献者设计两插件合并实现，"duplicate with #14054" |
| gs-0095 | #14451 | invalid → question → **invalid**（终） | ConfigValidationUtils 属 dubbo 二方包，提交者确认转问 dubbo——误发；首轮无回复时曾据口吻改判 question，据新证据纠正 |
| gs-0102 | #13866 | feature → bug | "Fixed #13933"，证实为缺陷而非能力缺失 |
| gs-0154 | #14126 | bug → invalid | 涉事类属 spring-cloud-alibaba 库，建议到该社区提 issue |
| gs-0232 | #15494 | question → bug | 维护者确认新控制台遗漏 argsPosition 配置项，需补充 |
| gs-0246 | #13835 | bug → invalid | "list api should not include configuration content"，v3 系有意设计 |
| gs-0251 | #14471 | feature → bug | 维护者以 bug 定性并 "Fixed by #14475" |
| gs-0168 | #14749 | duplicate 原号回填 | 社区回复指明 #9846（及 #14446） |
| gs-0284 | #14492 | duplicate 理由回填 | 回复指明 2.5.2 已修复（#13273） |

**据回复确认维持 10 条**：gs-0107/#14457（维护者明确"与 Nacos 无关，是新配置推送所致"）、gs-0127/#13915（"应提交到 rocketmq 社区"）、gs-0132/#14774（按文档自查的咨询）、gs-0136/#15536（"There is no IpParsingStrategy in Nacos"——误发）、gs-0188/#13990（SB4 适配问题属 spring-cloud-alibaba）、gs-0217/#14942（请求不合理被拒，沿 gs-0004 先例维持 feature）、gs-0277/#15409（.npmrc 系有意配置）、gs-0289/#15603（维护者给出修复方案，确认真缺陷）、gs-0106/#14111、gs-0199/#13888。

## 4. QA 轨道（已完成 AI 轮）

回复抓取完成后做了 QA 标注：160 条有实质回复的 question/bug/feature 候选中，**125 条产出 `qa`**（question 重述 + 中文 3–5 要点 ideal_answer_outline + sources 指向真实评论/URL，部分含 rubric_hints），35 条因回复无实质解决信息（仅 assign/纯链接/未收敛讨论）按"有据才产出"原则置 null，未编造。全量 300 条中 127 条有 QA（人工 2 + AI 125）。人工判例（gs-0051、gs-0053）已作为校准材料（`datasets/ai-annotation/qa/QA-EXAMPLES.md`）。任务书与批次见 `datasets/ai-annotation/qa/`，46 条子代理自标 review 未列入仲裁清单（QA 复核可与 κ 盲标并行）。

## 5. 下一步流程（golden set 定稿三步）

```bash
# ① 第二轮盲标（换人/换轮次，界面上 annotator 填 v2）
ANNOTATE_DATA=datasets/review/blind-round2.jsonl node scripts/annotate.mjs   # → http://localhost:8765
# ② 一致性检验（60 条分层盲标子集已生成，seed=42 可复现）
node scripts/kappa.mjs                                                        # κ≥0.75 达标；<0.6 先修标签定义
# ③ 仲裁 23 条待议 + 锁 holdout（8:2 提议见 §6）
```

## 6. holdout 锁定提议（未执行，需确认）

规范 §7.5：split=holdout 定稿后永不改。建议流程：v1 取 200 条 → 按主标签 × 开课月份分层、种子随机抽 40 条置 holdout，其余 160 条 dev（另 100 条标注富余留给 W4 扩充）。**本报告不落锁**；确认抽样方案后一键生成并应用。

## 7. 交付物清单

- `datasets/drafts/alibaba_nacos.jsonl` — 主数据文件（300 条全标 + 127 条含 QA + 271 条含维护者回复）
- `datasets/ai-annotation/round1/` — 分诊任务书、人工判例、8 批次输入/输出、reviews.json（仲裁清单）
- `datasets/ai-annotation/qa/` — QA 任务书、人工 QA 判例、6 批次输入/输出、merged.json
- `datasets/review/blind-round2.jsonl` — 60 条盲标子集（已剥离标签）
- `scripts/kappa.mjs` — Cohen's κ 计算器（含混淆矩阵与仲裁清单输出，已用全对合成用例验证）
- `scripts/annotate.mjs` — 新增 `ANNOTATE_DATA` 环境变量，支持指向盲标文件复标
