# daily-brief v2 设计稿：多用户 AI 情报日报（公网 SaaS 形态）

> 用户拍板的四个决策（2026-10-28）：**邀请码+日预算熔断**（成本模型）/ **免费服务器**（部署，阶段 B 定具体）/ **现在开工** / 目录 `daily-brief-v2/`，v1 原地保留可跑。
>
> 本文档是 v2 的架构依据与威胁模型，实现与文档不符时以「哪个对」论，不是以哪个先写论。

## 1. 产品形态与分阶段

多用户：注册（邀请码）→ 配自己的订阅主题（HN/GitHub/arXiv/RSS 自由组合）→ 每天 cron 产线逐人跑 → 各自微信收 Server酱 通知 → 网页读自己的报。

- **阶段 A（本设计范围）**：产品完整化——用户系统/多租户产线/SourcePlugin/预算熔断/XSS 净化，本地+局域网跑，但**按公网标准做安全**。结束即完整可用产品，非半成品。
- **阶段 B**：公网上线——部署到免费服务器（候选：Oracle Cloud 永久免费层常驻 4C24G，注册要卡；Cloudflare Tunnel 从家用机出，免费但电脑关机服务断；Render free 会休眠不适合 cron 常驻）、TLS、rate limit 硬化。
- **阶段 C**：运营迭代。

v1/v2 并存期任务计划只指一个（都跑=双份推送）：v2 全链验收当天把任务计划切到 v2，v1 留档。

## 2. 威胁模型（v1 没有而 v2 必须有的全部安全面）

| 攻击面 | 对策 | 残余风险（接受理由） |
|---|---|---|
| 未授权访问他人订阅/日报/key | 注册邀请码 + 登录 session（httpOnly cookie） | — |
| 成本被薅（恶意注册刷 LLM 配额） | 邀请码限量发放 + **全局日预算熔断**（DAILY_BUDGET_CALLS/TOKENS，超限当天全员停跑并落 status） | 预算内仍可被受邀者刷——熟人邀请制下可接受 |
| 密码拖库/爆破 | scrypt 慢哈希（node:crypto 零依赖）+ timingSafeEqual + 登录限流（server 层） | — |
| 存储型 XSS（用户 focus 进 prompt → writer 照抄 `<script>`） | H5 端 marked 输出过 **DOMPurify** 再进 v-html（v1 的「自产线信任」在多租户下不成立） | DOMPurify 配置失误——保持默认配置别自作聪明 |
| **SSRF**（用户填 RSS URL → 服务器替他请求内网） | rss 源专用 safeFetch：协议白名单 + DNS 解析 IP 私网黑名单 + **重定向手动逐跳重验**（30x 跳内网=绕过）+ 10s 超时 + 2MB 上限 | **DNS rebinding**（校验时解析公网、请求时解析内网）——完美防御需 pin IP 连接，原生 fetch 做不到，记档接受 |
| Prompt injection（focus/query 是产线输入） | researcher 的 URL⊆原始池程序断言保留（编造挡死）；注入最多污染自己的日报+烧自己份额 | 按人隔离即止损边界，可接受 |
| 注册/登录/触发产线滥用 | server 层内存令牌桶 per-IP（登录/注册 5/min，API 60/min） | 重启清零——可接受 |
| 撞库/用户名枚举 | 登录失败统一「用户名或密码不对」 | — |

## 3. 数据形状（全部落 `data/`，gitignored——含密码哈希与推送 key，绝不入库）

```
daily-brief-v2/
  DESIGN.md  sources.ts  users.ts  pipeline.ts  server.ts  probe.ts
  register-task.ps1            # cron 注册（A 阶段 Windows 开发机；B 阶段 Linux 换 systemd timer）
  data/
    users/<uid>/profile.json   # {id, username, pass: "salt:hash", sendkey?, admin, createdAt}
    users/<uid>/subscriptions.json
    reports/<uid>/YYYY-MM-DD.md + status-*.json + progress-*.json + history.json
    invites.json               # {code: {usedBy?, usedAt?}}——用一次即废
    sessions.json              # {token: {uid, expiresAt}} 30 天
    budget-YYYY-MM-DD.json     # 当日全局预算台账（跨用户累计）
  app/                         # uniapp H5（块 4 从 v1 复制改造）
```

uid 是 `randomBytes(8).toString('hex')`（16 字符随机）——目录名不受用户输入控制，无路径穿越面；username 只是显示+查重字段（`[a-zA-Z0-9_-]{3,32}`）。

## 4. 模块与关键决策

### sources.ts —— SourcePlugin 注册表（块 1）

- `SOURCES: Record<'hn'|'github'|'arxiv'|'rss', {label, fetch(query)}>`；订阅条目 `sources: [{type, query}]` 自由组合。
- hn/github 从 v1 原样搬；**arxiv** 新增（export.arxiv.org Atom XML，sortBy=submittedDate）；**rss** 通用源（行业新闻最大公约数）。
- **fast-xml-parser**（根仓新依赖）：手写 XML 解析（CDATA/entity/namespace/RSS2+Atom 双形状）坑大于收益，纯函数解析器值得破「server 零依赖」——零依赖纪律是 server 的路线选择，不是宗教。
- **safeFetch**（rss/arxiv 统一走）：SSRF 防护全套（见威胁模型）。
- **抓取去重**：run 级 `Map<type::query, Promise>` 缓存——N 人同订一个主题只打一次外部 API；失败不缓存（下次重试）。

### users.ts —— 用户系统（块 1）

- scryptSync(password, salt16B, 64B) 存 `salt:hash`；verify 用 timingSafeEqual（等长比较防时序）。
- session：登录发 `randomBytes(32).hex` token，sessions.json 存储（server 重启不掉线），30 天过期读时懒删。
- 邀请码：invites.json；**bootstrap**——零用户+空邀请池时用 env `BOOTSTRAP_INVITE_CODE`（缺省随机生成并打印一次，只此一次）。
- 重置码（忘记密码入口）：resets.json，与邀请码同构（admin 生成→线下转交→先验后消费、单次）；重置成功吊销该用户全部旧 session（密码都丢了旧会话不可信）。无邮件依赖——免费服务器不引第三方。
- 预置话题库 presets.ts：订阅从「填源」变「勾话题」（用户反馈）；RSS 源须实测可拉可解析才入库（36kr/zhihu 状态 200 但反爬页 0 items 不入）。自定义话题只填名字，自动配 hn/github/arxiv 检索源。
- admin：第一个注册用户自动 admin；admin 可生成邀请码/重置码、看全局预算与用户列表、全量补跑（最小面：/api/admin/*）。
- 写操作（注册/邀请码消费/session 写）全走串行队列（v1 emitProgress 同款）——读改写竞态的家常防线。

### pipeline.ts —— 多租户产线（块 2）

- 主循环逐人串行 `for user of users: runForUser(user)`（人内按主题 fanout 并行，v1 形状）；researcher/writer/critique 的 prompt 与流程从 v1 搬（5 发真跑+critic 打回迭代过的），订阅形状适配 sources 数组。
- **全局日预算熔断**：每次 LLM 调用记账进 budget-日期.json（跨用户累计 calls+tokens）；超限→当天剩余用户全部 skip（各自落 status: `skipped: budget`，不发假日报），次日 cron 自然重置。
- 通知：逐人用各自 sendkey（v1 多人推送函数复用，数组来源从「env 逗号串」变「users 目录」）。
- 落盘三件套按人分目录（同 v1 语义：同日重跑覆盖当日+history 跨日总账）。

### server.ts —— 多用户 API（块 3）

- session 鉴权中间件（cookie `sid` → sessions.json → req.user）。
- 路由：`POST /api/auth/register|login|logout|reset`（reset=忘记密码自救：用户名+admin 发的重置码+新密码，成功吊销该用户全部旧 session）· `GET /api/me` · `PUT /api/me`（sendkey/密码）· `GET /api/topic-presets`（预置话题库）· `GET|POST /api/topics`（当前人）· `GET /api/latest|/api/report?date=`（available 倒序，默认最新）`|/api/history|/api/progress?date=`（当前人）· `GET /api/events`（当前人 SSE）· `POST /api/run`（**只跑自己**，admin 可全量）· `/api/admin/invites|budget` · `GET /api/admin/users|POST /api/admin/reset-code`（admin 为用户造重置码，线下转交）。
- rate limit：内存令牌桶 per-IP。
- CORS 去掉 v1 的 `*`（公网同源部署；本地 dev 走 vite proxy 也同源）。
- 静态托管 app/dist/build/h5（uniapp 约定路径，v1 教训）。

### app/ —— uniapp H5（块 4）

- 新增登录/注册页（用户名/密码/邀请码）；「我的」页（填 SCT_SENDKEY、改密码、退出登录）。
- 日报/订阅/台账三页从 v1 搬，API 调用同源带 cookie。
- 订阅编辑页升级：每主题 sources 数组的增删（type 下拉 + query 输入）。
- markdown 渲染：marked → **DOMPurify** → v-html（v1 的裸 v-html 不再合法）。
- SSE/进度时间线/补跑按钮语义同 v1。

### probe.ts —— 零 token 探针（每块同步长）

P1 密码哈希往返/错密码/畸形存储 · P2 注册流（有效码成功/重码拒绝/用户名重复/弱密码）· P3 session 生命周期（登录/取出/过期/logout）· P4 SSRF 四拒（127.0.0.1/192.168/::1/file://）· P5 RSS2+Atom 双形状解析（含 CDATA）· P6 抓取缓存去重 · P7 多租户落盘隔离（A 的报不落 B 目录）· P8 预算熔断（第二人 skipped）· P9 通知 key 聚合。真发微信/真跑 LLM 不进探针（外部副作用纪律）。

## 5. env 增量（.env.example 同步）

| 变量 | 作用 | 缺省 |
|---|---|---|
| `V2_PORT` | v2 server 端口（v1 8787 不动，开发期并存） | 8788 |
| `DAILY_BUDGET_CALLS` | 全局日预算（LLM 调用次数） | 200 |
| `DAILY_BUDGET_TOKENS` | 全局日预算（tokens，prompt+completion 合计） | 500000 |
| `BOOTSTRAP_INVITE_CODE` | 首码（缺省随机打印一次） | — |

LLM 三件套/SCT/GITHUB_TOKEN 全局共用（运营者出 LLM 成本，BYOK 未选，靠邀请码+预算控）。

## 6. 开发顺序（五块，每块独立可验收）

1. **sources.ts + users.ts + probe P1~P6**（本块：纯函数层，探针先行）
2. pipeline.ts 多租户+熔断+去重（probe P7~P8，假 LLM 注入零 token）
3. server.ts 全 API（curl 验收清单）
4. H5 改造（浏览器人眼验收）
5. 全链真跑（真 LLM 一发）+ README v2 + TUTORIAL 记录 + 任务计划切换
