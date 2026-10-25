# GitHub App 上线指引（W4 真实流量）

> 目标：把 EvoKeeper 挂到你的沙盒仓库，开始真实 issue 分诊。
> 全程约 30 分钟（大部分是 GitHub 页面操作）。

## 1. 注册 GitHub App（10 分钟）

打开 **github.com/settings/apps/new**（个人账户），填写：

| 字段 | 填什么 |
|---|---|
| GitHub App name | `evokeeper-dev` |
| Homepage URL | 任意（如你的 GitHub 主页） |
| **Webhook URL** | `https://<你的公网地址>:8787/webhook`（见第 3 步内网穿透） |
| **Webhook secret** | 随机字符串（记下来，写入 .env.local） |
| Permissions → Issues | **Read & write**（R2 红线：只勾这一个写权限） |
| Permissions → Metadata | Read（必选，默认勾上） |
| Subscribe to events | **Issues**、**Issue comments**（只勾这两个） |
| Where can this app be installed | Only on this account（沙盒阶段） |

创建后：
- 记下 **App ID**（General 页 About 区的数字；`GET /apps/{slug}` 对未公开 App 会 404，只能手抄）
- 新版 UI：左侧栏 **Credentials → Key pairs 标签 → Generate**（不是 Client secrets！）→ 下载 `.pem`
- 事件订阅：**Permissions & events 页 → Subscribe to events**，勾 **Issues** 和 **Issue comment**
  （不勾则 GitHub 一条 webhook 都不会发——投递记录为空时先查这里）

## 2. 安装到仓库（2 分钟）

- App 设置页 → Install App → **Only select repositories** → 选目标仓库（本项目直接用 `awei-1639/evokeeper` 自举）
- Installation ID 不用手抄：`node scripts/setup-app-env.mjs <pem路径> --app-id <AppID>`
  自动完成 反查 App → JWT 验签 → 抓 installation → 验证可见仓库 → 写 .env.local 三行

## 3. 内网穿透（webhook 公网可达，5 分钟）

```bash
./cloudflared.exe tunnel --url http://localhost:8787 --no-autoupdate
# 输出的 https://xxx.trycloudflare.com 即隧道地址
```

注意：免费隧道地址每次重启会变——变了就重跑第 5 步脚本（它会自动 PATCH 新地址）。

## 4. 配置并启动（3 分钟）

`scripts/setup-app-env.mjs` 已把三元组写进 `.env.local`（PEM 自动压成单行 `\n` 转义；
`githubAppAuthFromEnv` 会把字面 `\n` 还原成真实换行——W4 实测不还原会报
OpenSSL `DECODER routines::unsupported`）。

启动（自动注入 .env.local，服务 cwd=仓库根，轨迹/审计落在 datasets/ 下）：

```bash
node scripts/dev-webhook.mjs
# 横幅会打印 [github] GitHub App 认证（installation token，1h 缓存）
```

（没配 App 凭据时自动降级：有 GITHUB_TOKEN → PAT；都没有 → DryRun，动作只记录不外发——本地调试安全。）

## 5. 验证（5 分钟，全自动）

```bash
node scripts/e2e-verify.mjs <隧道域名>   # 例：node scripts/e2e-verify.mjs abc-xyz.trycloudflare.com
```

脚本会：探活隧道 → `PATCH /app/hook/config` 回填 webhook URL（比手填页面可靠）→
用 App 身份建测试 issue → 轮询 `/app/hook/deliveries` 确认投递 202 → 轮询 issue 等 Bot 打标。

判定通了的标准：issue 上出现 Bot 打的标签（如 `bug`），
`datasets/gateway/audit.jsonl` 出现 allowed=true 的 addLabels 审计记录，
`datasets/traces/traces.jsonl` 新增 `trace-<delivery-id>` 轨迹（含 LLM 成本）。

## 6. 跑一周后（W4 验收）

- `pnpm scan:daily` 每日收集反应信号 → JudgedTrace
- 7 天数据攒够 → 睡眠整理 → 管理台评审 → 门禁 → **第一个经验版本发布**（W6 里程碑）

## 安全红线回顾

- App 权限只有 Issues:write + Metadata:read（R2：禁止 code write）
- webhook 验签强制开启（GITHUB_WEBHOOK_SECRET 未配置时打印警告）
- 写动作全部过 gateway：幂等键防重放、24h 评论冷却、单次 ≤2 标签 + ≤1 评论
