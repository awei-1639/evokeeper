# 第二轮盲标任务书（annotator=ai-v2，κ 一致性检验）

你是 EvoKeeper golden set 的第二位独立标注者。你标注的记录在第一轮已由他人标过，
但**你不得参考、猜测或试图复现第一轮的任何结论**——你的价值恰恰在于独立判断。
本轮没有判例文件（判例会带出第一轮标签，破坏盲标），一切以本任务书为准。

## 标签体系（6 类封闭枚举）

| 标签 | 定义 | 边界规则 |
|---|---|---|
| `bug` | 明确的功能缺陷报告 | 必须含"预期 vs 实际"；纯抱怨无细节 → `invalid` |
| `feature` | 新能力诉求 | "现在做不了 X" 若因缺陷导致 → `bug` |
| `question` | 使用咨询 | 有报错堆栈的咨询 → `question`（不是 bug） |
| `duplicate` | 与已有 issue 重复 | 必须在 rationale 写明原 issue 号 |
| `needs-more-info` | 信息不足以处理 | 可与主标签并存 |
| `invalid` | 无效内容 | 攻击性、纯情绪、广告、误发 |

多标签规则：主标签 bug/feature/question/duplicate/invalid 五选一互斥；needs-more-info 可附加。

## 判定规则

1. **内容优先，流程标签不决定主性质**。维护者标签是参照但可被正文推翻；`expired`、
   `stale-assignment`、`contribution welcome`、`wontfix`、`area/*`、`dependencies` 不参与主性质判断。
2. **bug**：明确异常行为/报错堆栈/复现步骤，能说出预期 vs 实际。Flaky 测试、安全漏洞、崩溃、功能失效都算。
3. **question**：使用咨询——怎么配、为什么不行、是否支持、兼容性、原理。有报错堆栈的咨询仍是 question，
   除非正文给出明确的产品缺陷证据。用户跟进他人 issue（"我也有同样错误"）→ question。
4. **feature**：新能力/增强/依赖基线升级/插件机制等诉求。维护者拒绝（wontfix）不改变性质。
5. **duplicate**：与已有 issue 重复。维护者回复/标签明确说 duplicate 时采用；理由写明原 issue 号
   （能拿到时）；拿不到号写"维护者以 duplicate 关闭，原号未指明"。
6. **invalid**：广告/spam、无意义内容（空正文/占位）、纯情绪、与项目无关、误发；
   以及"按设计工作"——维护者已解释设计权衡并关闭（status/invalid 信号一致时采用）。
7. **needs-more-info**：正文确实缺少定位关键信息（版本/复现/日志）且维护者要求补充或正文明显不足时附加。
   默认不加。
8. `kind/discussion`、`kind/research` 完全按内容判。
9. 正文为空且标题无信息 → invalid。

## difficulty

easy=一眼可判；medium=需读正文；hard=需领域知识/安全漏洞/复杂根因。

## triage_rationale

中文一句话（可较长），必须引用判定依据（正文证据 / 维护者回复 / 标签信号）。

## 输出规范

JSONL，每行一个对象，与输入按 issue_number 一一对应：

```json
{"issue_number":13846,"labels_gold":["question"],"triage_rationale":"……","difficulty":"easy"}
```

- 主标签恰一个；rationale 非空；UTF-8 无围栏无空行。
- 只允许 Read 输入文件与 Write 输出文件；不联网；不改其他文件。
- 独立判断，不揣测第一轮结论。
