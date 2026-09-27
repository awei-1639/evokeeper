# 标注任务书（AI 第 1 轮，annotator=ai-v1）

你在为 EvoKeeper 项目标注 golden set（GitHub 仓库 alibaba/nacos 的真实 issue）。
本轮只标**分诊标签**（labels_gold + triage_rationale + difficulty），不标 QA。
输入批次文件里每条 issue 给出：标题、正文摘录、维护者标签（raw_labels）、评论数、时间、URL、维护者回复摘要、（部分有）duplicate_hint。

## 标签体系（6 类封闭枚举，来自 docs/annotation-guideline.md §3）

| 标签 | 定义 | 边界规则 |
|---|---|---|
| `bug` | 明确的功能缺陷报告 | 必须含"预期 vs 实际"；纯抱怨无细节 → `invalid` |
| `feature` | 新能力诉求 | "现在做不了 X" 若因缺陷导致 → `bug` |
| `question` | 使用咨询 | 有报错堆栈的咨询 → `question`（不是 bug） |
| `duplicate` | 与已有 issue 重复 | 必须在 `triage_rationale` 写明原 issue 号 |
| `needs-more-info` | 信息不足以处理 | 常与其他标签并存（见多标签规则） |
| `invalid` | 无效内容 | 攻击性、纯情绪、广告、误发 |

**多标签规则**：`needs-more-info` 和 `invalid` 可与主标签并存；其余四个主标签互斥（一个 issue 只有一个"主性质"）。主标签必须是 bug/feature/question/duplicate/invalid 之一。

## 判定规则（结合 nacos 人工第 1 轮的先例提炼）

1. **内容优先，流程标签不决定主性质**。维护者标签是重要参照，但可以被正文推翻（判例 gs-0006：维护者标 spam，实际是真 bug；gs-0004：标 wontfix 仍判 feature）。`expired`（僵尸关闭）、`stale-assignment`、`contribution welcome`、`wontfix`、`area/*`、`dependencies` 等标签**不参与**主性质判断。
2. **bug 判据**：存在明确的异常行为/报错堆栈/复现步骤，能说出"预期是什么、实际是什么"。Flaky 测试、安全漏洞（越权/路径穿越/反序列化）、崩溃、功能失效都算 bug。
3. **question 判据**：使用咨询——"怎么配、为什么不行、是否支持 X、版本兼容性、原理询问"。**有报错堆栈的咨询仍是 question**，除非正文给出了明确的缺陷证据（预期 vs 实际的偏差是产品缺陷而非用户配置问题）。用户反复跟进别人的 issue（"我也有同样错误"）→ question（可加 needs-more-info）。
4. **feature 判据**：请求新能力/增强/依赖基线升级/精简发行版/插件机制等。`kind/enhancement`、`kind/feature`、`kind/proposal`、"建议/希望支持/能不能加"都是强信号。维护者拒绝（wontfix）不改变性质。
5. **duplicate 判据**：与已有 issue 重复。`status/duplicate` 是强信号。理由里**必须写明原 issue 号**（从维护者回复或 duplicate_hint 提取，如"duplicate with #14606"）。若确实找不到原号：仍判 duplicate，理由写"维护者以 duplicate 关闭，原 issue 号未在数据中指明"，并加 review 标记。
6. **invalid 判据**：广告/spam（与项目无关的客服热线、外语推广）、无意义内容（标题 na、正文空/模板占位）、纯情绪无细节、误发；以及**"按设计工作"**——用户认为是缺陷，维护者已解释这是设计权衡/用户误用并关闭（判例 gs-0013、gs-0028、gs-0051）。
7. **needs-more-info 附加规则**：正文确实缺少定位所需的关键信息（版本号/复现步骤/配置/日志），且（维护者要求补充 `status/need feedback`，或正文明显不足）时附加。注意：这只是"判定"不是"贴标签"——need feedback 出现且正文确实缺关键信息 → 附加；若维护者后续已补齐信息并解决，则不必附加。
8. **kind/discussion、kind/research**：完全按内容判（判例里 discussion 有判 bug 的、有判 question 的）。提出改造方案 → feature；咨询现状 → question；报告缺陷 → bug。
9. 中英文正文都正常；正文为空时靠标题 + 维护者标签判断，若完全无从判断 → invalid + review 标记。
10. 一条 issue 只输出一个主标签；宁可用 review 标记表达不确定，也不要输出两个主标签。

## difficulty（标注者直觉，用于切片分析）

- easy：一眼可判（典型广告、明显咨询、明显重复）；
- medium：需读正文才能判断；
- hard：需要领域知识/多轮信息/安全漏洞/复杂根因（对照判例：路径穿越、SSRF、VIP 漂移重连 = hard）。

## triage_rationale 写法

中文一句话（可较长），**必须引用判定依据**：正文里的证据、维护者回复/标签信号、或与哪个 issue 重复。风格对照 EXAMPLES.md 的人工理由（如"用户咨询……维护者指出……"）。禁止只写"这是一个 bug"这类无依据的话。

## 输出规范（严格遵守）

- 输出到指定文件，JSONL，**每行一个 JSON 对象，与输入批次一一对应（按 issue_number 匹配），共 28 行**：
  ```json
  {"issue_number":13846,"labels_gold":["question"],"triage_rationale":"……","difficulty":"easy"}
  ```
- 可选字段 `review`：仅当该条你不确定或需要人工复查时才加，写明不确定点（如 "review":"bug 与 question 边界，正文缺复现细节"）。不要滥用——预期 28 条里有 0-5 条。
- labels_gold 数组元素必须来自 6 个枚举值；主标签恰好在 bug/feature/question/duplicate/invalid 中取一个。
- 文件必须可直接被 `JSON.parse` 逐行解析：UTF-8、无 markdown 代码围栏、无注释、无空行。
- 只允许：Read 三个输入文件（任务书、判例、批次）、Write 一个输出文件。不得改动其他任何文件，不联网，不运行代码。
