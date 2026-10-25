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
- 记下 **App ID**（设置页顶部）
- 页面底部 **Private keys** → Generate a private key → 下载 `.pem` 文件

## 2. 安装到沙盒仓库（2 分钟）

- 新建一个测试仓库（比如 `yourname/evokeeper-sandbox`），放个 README 即可
- GitHub App 设置页 → Install App → Install to your account → **Only select repositories** → 选沙盒仓库
- 安装完成后，从安装页 URL 末段拿到 **Installation ID**（`/installations/<这串数字>`）

## 3. 内网穿透（webhook 公网可达，5 分钟）

GitHub 必须能从公网 POST 到你的 webhook。任选其一：

```bash
# 方案 A：cloudflared（免注册，推荐）
cloudflared tunnel --url http://localhost:8787
# 输出的 https://xxx.trycloudflare.com 填到 App 的 Webhook URL

# 方案 B：ngrok（需注册）
ngrok http 8787
```

注意：免费隧道地址每次重启会变——变了就去 App 设置页更新 Webhook URL。

## 4. 配置并启动（3 分钟）

`.env.local` 追加四行（PEM 私钥是**多行**的，用 `\n` 连接成一行）：

```bash
GITHUB_APP_ID=你的AppID
GITHUB_APP_PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----
GITHUB_INSTALLATION_ID=安装ID
GITHUB_WEBHOOK_SECRET=第1步的webhook secret
```

启动：

```bash
pnpm --filter @evokeeper/agent dev
# 横幅会打印 [github] GitHub App 认证（installation token，1h 缓存）
```

（没配 App 凭据时自动降级：有 GITHUB_TOKEN → PAT；都没有 → DryRun，动作只记录不外发——本地调试安全。）

## 5. 验证（5 分钟）

1. 沙盒仓库提一个测试 issue（比如标题 `[Bug] 部署后启动失败`）
2. 看服务日志：应出现 `[inbox] issues delivery=... -> accepted` → `[gateway] ...`
3. 几秒内 issue 上出现 Bot 的标签（如 `kind/bug`）与评论 → **链路通了**
4. 管理台 `pnpm --filter @evokeeper/web dev` → 轨迹页应能看到这次处理的完整 TraceStep（含成本）

## 6. 跑一周后（W4 验收）

- `pnpm scan:daily` 每日收集反应信号 → JudgedTrace
- 7 天数据攒够 → 睡眠整理 → 管理台评审 → 门禁 → **第一个经验版本发布**（W6 里程碑）

## 安全红线回顾

- App 权限只有 Issues:write + Metadata:read（R2：禁止 code write）
- webhook 验签强制开启（GITHUB_WEBHOOK_SECRET 未配置时打印警告）
- 写动作全部过 gateway：幂等键防重放、24h 评论冷却、单次 ≤2 标签 + ≤1 评论
