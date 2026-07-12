# Atelier452 Magic — 公开站部署指南

同一套代码三种形态：桌面 EXE（默认）、本地网页（`npm start`）、**公开多用户站**（本文）。

## 公开站启用

设环境变量后启动 `node server.js`：

| 变量 | 必填 | 说明 |
|---|---|---|
| `A452_PUBLIC=1` | ✅ | 启用登录墙 + 积分计费 + 每用户工程隔离 |
| `SITE_URL` | ✅ | 站点公网地址（如 `https://magic.example.com`）。转绘参考视频直接用它，无需隧道 |
| `GOOGLE_CLIENT_ID` | ✅ | Google OAuth Web 客户端 ID（见下） |
| `STRIPE_SECRET_KEY` | 收费必填 | Stripe 密钥（`sk_live_...` / 测试 `sk_test_...`） |
| `STRIPE_WEBHOOK_SECRET` | 建议 | Stripe webhook 签名密钥（`whsec_...`） |
| `ADMIN_EMAILS` | 建议 | 逗号分隔的管理员邮箱（只有他们能改全局 API 设置） |
| `FREE_CREDITS` | 可选 | 新用户赠送积分，默认 20 |
| `A452_DEV_LOGIN=1` | 仅本地 | 开发登录旁路，**生产环境务必不设** |
| `PORT` | 可选 | 默认 5893 |

服务器还需要：Node ≥ 18、ffmpeg（`FFMPEG_DIR` 可指定）、`config.json` 里配好方舟 API Key（成本由你承担，靠积分定价回收）。

## Google 登录配置

1. [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → 创建 OAuth Client ID（类型 Web application）
2. Authorized JavaScript origins 填你的域名（本地调试再加 `http://localhost:5893`）
3. 把 Client ID 填入 `GOOGLE_CLIENT_ID`

## Stripe 支付配置

1. [Stripe Dashboard](https://dashboard.stripe.com/apikeys) 拿 Secret key
2. Webhooks → Add endpoint：`https://你的域名/api/pay/webhook`，事件选 `checkout.session.completed`，拿 Signing secret
3. 充值包/价格在 `public-mode.js` 顶部 `PACKS`，功能定价在 `PRICING`（当前：一体 3 积分/s、分段 2/s、转绘 4/s、精修 5/次，失败自动退）

## 推荐部署方式

**VPS（推荐，ffmpeg 自由）**：
```bash
# Ubuntu
apt install -y ffmpeg nodejs npm caddy
git clone <你的仓库> && cd inbetween-studio && npm install --omit=dev
# systemd 服务设置环境变量后 node server.js
# Caddyfile: magic.example.com { reverse_proxy 127.0.0.1:5893 }  # 自动 HTTPS
```

**Render/Railway**：Node 服务 + 构建时装 ffmpeg（Render 用 apt 包或静态二进制），环境变量照上表填。
注意：数据目前存 JSON 文件（`data/users.json` 等），平台的磁盘需持久化（Render Persistent Disk）。

**中国大陆访问注意**：Google 登录和 Stripe 在大陆不可直连；面向大陆用户需换微信/支付宝 + 手机号登录（未实现）。当前形态适合面向海外用户。

## 安全与扩容备忘

- 用户/会话/积分是 JSON 文件存储，适合起步（<几千用户）；量大后迁 SQLite/Postgres
- 生成产物 `videos/`、`assets/` 会持续增长，建议定期清理或挂对象存储
- webhook 已做签名校验；生产务必配置 `STRIPE_WEBHOOK_SECRET`
- 桌面 EXE 和本地 `npm start` 完全不受这些变量影响（不设 `A452_PUBLIC` 即旧行为）
