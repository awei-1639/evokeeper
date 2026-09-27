# QA 标注任务书（AI 轮，服务于"回答质量"评测轨道）

你在为 EvoKeeper golden set 补充 QA 标注：把真实 issue + 维护者的实际解决过程，整理成"标准问题 + 理想答案要点清单"，供后续 LLM-judge 按要点覆盖度打分。

## 产出定义（schema 与 datasets/examples/golden-set.sample.jsonl 一致）

```json
{"issue_number":13888,"qa":{"question":"……","ideal_answer_outline":"1) …… 2) …… 3) ……","sources":["……"],"rubric_hints":"……"}}
```

- `question`：把该 issue 的问题重述为**独立、自洽**的提问——不看原 issue 的第三方也能直接作答，不写"这个问题/如题"之类指代。语言与 issue 正文一致（中文 issue → 中文 question，英文 issue → 英文 question）。
- `ideal_answer_outline`：**一律中文**（保留必要英文技术名词），3–5 条编号要点（"1) … 2) …"）。每条是一个**可判定的断言**，描述"好回答应指出/给出什么"（如"指出了配置项遗漏这一原因"），不是泛泛的方向。
- `sources`：字符串数组，只允许两类出处：① 数据中出现的评论 → `"issue#13888 评论 ziyoushibo"`；② 正文/回复中真实出现的 URL → 引用该 URL 原文。**禁止编造**文档路径、issue 号。
- `rubric_hints`（可选，一句话）：该案例中好回答与坏回答的区分特征（如"应给出具体配置项名而非建议升级了事"）。

## 硬性规则

1. **有据才产出**：维护者回复（或回复+正文合起来）必须包含**实质性解决信息**——原因分析、修复方式/修复版本/PR 号、具体配置方法、明确结论。只有"收到"、"Assigned"、"请补充信息"、"@某人"、"给个文档链接但无解释"不算实质 → 该条输出 `"qa":null`。宁可 null，不可编造（guideline §6：要点必须能从真实解决过程推导）。
2. 要点内容必须与 maintainer_replies 的观点**一致**，不得引入数据中没有的事实（如你自己知道的 Nacos 知识、推测的版本号）。
3. 缺陷类（bug）的要点应覆盖：原因 + 解决/规避方式（含修复版本或 PR 号，若回复中有）；咨询类（question）的要点应覆盖：直接答案 + 验证方式/注意事项（若数据中有）。
4. feature 类大多无"解决过程"，仅在回复给出明确替代方案/已有能力说明时才产出，否则 null。
5. 不修改 labels/difficulty/triage_rationale，只产出 qa。

## 输出规范

- 写到指定输出文件，JSONL，**每行一个对象、与输入按 issue_number 一一对应**：`{"issue_number":N,"qa":{...}|null}`（不确定时加 `"review":"..."`）。
- UTF-8、无 markdown 围栏、无空行；`ideal_answer_outline` 内换行一律写成一行内的编号要点。
- 只允许 Read 输入文件与 QA-EXAMPLES.md、Write 输出文件；不联网；不改其他文件。
