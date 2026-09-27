# 人工 QA 判例（annotator=v1）

> 以下 2 条是人工标注的完整 QA，注意其结构：question 为独立重述的提问；ideal_answer_outline 为编号要点清单（每点是一个可判定断言）；sources 标注真实出处；rubric_hints 给出好/坏回答的区分特征。

## gs-0051（issue #15683，labels_gold=["invalid"]）
- 标题：Nacos v3 未授权访问接口泄露服务配置信息
- qa.question：Nacos v3 的 /v3/console/server/state 接口无需登录即可访问，是否属于安全漏洞？
- qa.ideal_answer_outline：
  - 1. 明确指出这是设计预期而非漏洞：/v3/console/server/state 是 Nacos 3.X 定义的 Public API（公开接口）。
  - 2. 解释设计目的：该接口用于在未认证时返回基础元数据（如版本、启动模式、端口等），以便客户端或控制台能正确适配服务端。
  - 3. 给出关闭方案：若确实不希望公开该信息，可在配置文件中设置 `nacos.core.auth.console.enabled=false` 并重启控制台。
  - 4. 安全提报指引：如果基于特定部署环境仍认为存在安全隐患，应按照官方要求提交至阿里云安全应急响应中心（ASRC），而非在 GitHub 公开讨论。
- qa.sources：["issue#15823","official-docs:auth-plugin"]
- qa.rubric_hints：好回答应包含：明确指出接口属设计预期（Public API），解释其用于获取元数据的设计初衷，提供官方配置项或安全提报渠道。
坏回答应包含：盲目附和用户认为这是安全漏洞，未指出属于设计预期，未提供关闭配置说明或引导至官方安全平台。

## gs-0053（issue #13843，labels_gold=["question"]）
- 标题：duplicated ephemeral instance
- qa.question：Nacos 中出现重复的临时实例（duplicated ephemeral instance）是什么原因导致的？
- qa.ideal_answer_outline：
  - 指出临时实例的重复通常与客户端网络环境（如多网卡、IP 变化）或心跳重连机制有关。
  - 说明可能是服务端清理机制存在滞后，客户端重连后旧实例未及时下线。
  - 强调需补充 nacos-client 版本、服务名、完整 instanceId 及服务端日志才能定位具体原因。
  - 建议排查客户端是否注册了多个 IP 或启动了多次实例。
- qa.sources：["issue#13843"]
- qa.rubric_hints：好回答应指出多网卡、心跳重连等常见原因，并强调补充日志排查。
坏回答应避免直接断言这是 Nacos 服务端 Bug，避免只回复“重启解决”。

