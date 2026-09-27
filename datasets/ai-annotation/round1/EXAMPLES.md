# 人工标注判例（第 1 轮，annotator=v1，nacos 真实数据）

> 以下每条给出：标题 | 维护者标签 | 人工判定 labels_gold + difficulty | 人工 triage_rationale（全文）。学习其判定逻辑与理由的写法。

## gs-0001（issue #13846）
- 标题：Nacos 3.0对客户端的版本要求最低是多少？
- 维护者标签：[kind/question]
- 人工判定：["question"] / difficulty=easy
- 理由全文：版本兼容性使用咨询，无缺陷或新能力诉求

## gs-0002（issue #13886）
- 标题：关于2.5.1的版本扫描出CORS 信任任意来源漏洞
- 维护者标签：[kind/question]
- 人工判定：["question"] / difficulty=medium
- 理由全文：用户就 CORS 配置未生效咨询原因，未提供代码缺陷证据，属使用咨询

## gs-0003（issue #13968）
- 标题：服务启用单机模式，但是日志好像提示的是集群模式竞选leader
- 维护者标签：[kind/question]
- 人工判定：["bug","needs-more-info"] / difficulty=medium
- 理由全文：配置单机模式但日志仍显示集群选主，存在预期与实际行为不符

## gs-0004（issue #14059）
- 标题：Global Search
- 维护者标签：[status/wontfix]
- 人工判定：["feature"] / difficulty=easy
- 理由全文：跨命名空间全局搜索属新能力诉求；维护者以违背命名空间隔离设计为由拒绝，但不改变性质

## gs-0005（issue #14409）
- 标题：{{Telefonberatung Nutzen**LH®}}Wie kann ich mit einem Lufthansa Mitarbeiter spre
- 维护者标签：[spam]
- 人工判定：["invalid"] / difficulty=easy
- 理由全文：与 Nacos 无关的客服热线推广垃圾内容，维护者已标 spam

## gs-0006（issue #14495）
- 标题：python fastapi 后端agent服务，注册nacos问题
- 维护者标签：[spam]
- 人工判定：["bug"] / difficulty=hard
- 理由全文：现象（注册后一次长请求即被注销删除）、根因指向（SDK 连接重试缺陷，维护者发 3.0.4 修复并指向 #14501）、排除用户误用（配置与官方 demo 一致）。

## gs-0008（issue #14944）
- 标题：:sparkles: spring-boot upgrade to 4.x
- 维护者标签：[dependencies]
- 人工判定：["feature"] / difficulty=medium
- 理由全文：依赖基线升级诉求（Spring Boot 4.x EOL 驱动）、非缺陷/非咨询、维护者已纳入 milestone 规划。

## gs-0012（issue #15709）
- 标题：nacos-client 3.2.3: sun.misc.Unsafe::allocateMemory warning from shaded Netty st
- 维护者标签：[]
- 人工判定：["duplicate"] / difficulty=easy
- 理由全文：经核对，该问题已由 #15708 报告，属重复 issue（duplicate #15708）。

## gs-0013（issue #15823）
- 标题：Auth plugin lookup failure silently disables all @Secured checks (fail-open) — s
- 维护者标签：[status/invalid, kind/question]
- 人工判定：["invalid"] / difficulty=easy
- 理由全文：维护者已解释此行为系设计权衡（避免配置错误导致服务器启动阻塞，保障可用性），提交者表示理解并同意关闭，属于配置预期之外的咨询，非缺陷（invalid）。

## gs-0022（issue #15236）
- 标题：Nacos bug
- 维护者标签：[status/need feedback, expired]
- 人工判定：["bug"] / difficulty=medium
- 理由全文：用户反馈 Nacos Client 2.2.0 与 Server 2.3.1 的 gRPC 长连接断开后未自动重连注册，需重启应用恢复（Bug）。维护者要求补充客户端重连情况但已过期，需更多反馈（needs-more-info）。

## gs-0026（issue #15802）
- 标题：Nacos 配置持久化路径穿越
- 维护者标签：[]
- 人工判定：["bug"] / difficulty=hard
- 理由全文：用户报告 Nacos 配置持久化存在路径穿越漏洞（group=.. 可逃逸目标目录），维护者已要求提交至阿里云安全应急响应中心（ASRC）处理，属严重安全缺陷（Bug / Security）。

## gs-0037（issue #15529）
- 标题：mcp tool 如何支持 图片二进制的转发
- 维护者标签：[status/need feedback, expired, area/MCP]
- 人工判定：["question"] / difficulty=easy
- 理由全文：用户咨询 MCP tool 如何支持图片二进制转发，维护者指出可能系 higress 网关不支持该功能，但用户长时间未反馈导致过期（question / needs-more-info）。

## gs-0040（issue #13837）
- 标题：在页面上创建的sse MCP Server ,使用nacos-mcp-router ,add_mcp_server失败
- 维护者标签：[status/need feedback]
- 人工判定：["question","needs-more-info"] / difficulty=medium
- 理由全文：用户咨询 sse MCP Server 使用 nacos-mcp-router 添加失败的问题，维护者分析报错系实际调用后端 MCP 服务时抛出的 400 bad request（与 mcp-router 无关），建议排查后端 server 是否支持 streamable，需进一步反馈（question / needs-more-info）。

## gs-0059（issue #14614）
- 标题：[BUG] find the same error with #14122 in image nacos/nacos-server:v3.2.0-BETA
- 维护者标签：[kind/question]
- 人工判定：["question","needs-more-info"] / difficulty=easy
- 理由全文：用户反馈在 k8s 中使用 nacos/nacos-server:v3.2.0-BETA 镜像时复现了 #14122 的错误，怀疑相关修复代码未合并到该镜像中，维护者已将其定性为使用咨询（question），需补充具体报错信息及镜像构建版本进一步核查（needs-more-info）。

