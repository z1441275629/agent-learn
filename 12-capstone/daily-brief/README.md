# daily-brief：AI 情报日报（个人研究助理）

一条全自动产线：每天 09:00 按你的订阅主题抓 Hacker News / GitHub / arXiv → LLM 精选+翻译+点评 → 生成 markdown 日报 → 微信推送通知 + 局域网网页读报。

```
任务计划(cron) ─→ pipeline.ts ─→ reports/YYYY-MM-DD.md（日报）
                    │                status-日期.json（当天状态）
                    │                history.json（跨日成本台账）
                    │                progress-日期.json（进度事件流）
                    ├→ Server酱 ─→ 微信「已生成」卡片
                    └→ server.ts(常驻 HTTP) ─→ 手机/电脑浏览器读报
```

**角色分界**：跑产线的机器是「运营者」（要配置）；读报的手机是「读者」（零配置，连同一 WiFi 开网址）。

---

## 运营者部署（一次 15 分钟）

### 前置

- Windows 10/11 + [Node.js ≥ 22.18](https://nodejs.org)（原生支持 TypeScript type stripping，`.ts` 不用编译直接跑）
- 任一 OpenAI 兼容端点的 API key（智谱 GLM / DeepSeek / OpenAI 都行）

### 步骤

```bash
# 1. 装依赖（仓库根 + 前端子项目）
npm install
cd 12-capstone/daily-brief/app && npm install && npm run build:h5 && cd ../..

# 2. 配置 .env（仓库根，模板见 .env.example）
#    必填只有 LLM 三件套，其它都有合理缺省

# 3. 起读报服务（常驻；手机/电脑浏览器开它）
node 12-capstone/daily-brief/server.ts

# 4. 手动跑一发产线验证全链（烧一发 LLM 配额，约 6 次调用）
node 12-capstone/daily-brief/pipeline.ts

# 5. （Windows）注册每天 09:00 任务计划——管理员 PowerShell
powershell -ExecutionPolicy Bypass -File .\12-capstone\daily-brief\register-task.ps1
```

### .env 配置表

| 变量 | 必填 | 作用 | 缺省行为 |
|---|---|---|---|
| `LLM_BASE_URL` | ✅ | OpenAI 兼容端点（如智谱 `https://open.bigmodel.cn/api/paas/v4`） | 无——产线起不来 |
| `LLM_MODEL` | ✅ | 模型名（如 `glm-4.5` / `deepseek-chat`） | 无 |
| `LLM_API_KEY` | ✅ | key | 无 |
| `SCT_SENDKEYS` | 可选 | [Server酱](https://sct.ftqq.com) 微信推送。**多人**：每人各自注册扫码拿自己的 key，逗号分隔（免费 5 条/天/人，每天只用 1 条） | 不配=不推送，产线照常跑 |
| `SCT_SENDKEY` | 可选 | 旧单数写法（等价数组的 1 个成员，可与复数并存） | 同上 |
| `GITHUB_TOKEN` | 可选 | GitHub 搜索 API 限额 60→5000 req/h（[建 token](https://github.com/settings/tokens)，勾 public_repo 即可） | 匿名 60/h，每天 4 次抓取够用 |
| `BRIEF_PORT` | 可选 | 读报服务端口 | 8787 |
| `BRIEF_PUBLIC_URL` | 可选 | 通知里「打开日报」链接 | 自动探测当前局域网 IP（换热点/路由自动跟随）；走内网穿透固定域名时才钉死 |

### 订阅主题（你要看什么）

编辑 [subscriptions.json](subscriptions.json)：每个主题一条 `{id, name, focus, hnQuery, githubQuery}`。改完不用重启——产线每次启动时读它。也可以在网页端「订阅」页里改（走 API 落回同一文件）。

---

## 读者使用（零安装）

手机连**同一 WiFi**，浏览器打开 server 启动时打印的地址（形如 `http://192.168.x.x:8787`）。三个页面：

- **日报**：当天 markdown 日报 + 历史日期切换；产线在跑时能看到实时进度时间线，还能点「补跑」手动触发
- **订阅**：改主题关键词（要 server 在线）
- **台账**：每次运行的 LLM 调用数 / token 消耗 / 耗时

> 局域网边界：手机离开这个 WiFi（如用流量）就读不了——微信通知卡片里的链接同理。要外网访问需自配内网穿透（frp / 花生壳等），然后把穿透域名配进 `BRIEF_PUBLIC_URL`。

### 手机打不开？按序查三件事

1. **防火墙开没开**：管理员 PowerShell 跑 `Get-NetFirewallProfile`——`Enabled=False` 说明防火墙根本没拦，跳到第 3 条；开着的话需要放行端口：
   `New-NetFirewallRule -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8787 -RemoteAddress 10.0.0.0/8,172.16.0.0/12,192.168.0.0/16`
2. **放行规则对不对**：上面的命令是「端口 + 私网段」收敛放行（不给你机器上所有程序开门），三个私网段全覆盖，换 WiFi 不用重配
3. **热点/路由器 AP 隔离**：防火墙关着还打不开，基本就是它——设备间互访被禁，换个热点验证，或去路由器设置里关「AP 隔离」

---

## 运维速查

```bash
node 12-capstone/daily-brief/pipeline.ts   # 手动跑产线（烧 LLM 配额）
curl -X POST http://localhost:8787/api/run  # 网页端「补跑」按钮背后就是这个
node 12-capstone/daily-brief/probe.ts      # 零 token 自检探针（16 项，不烧钱）
node 12-capstone/daily-brief/server.ts     # 读报服务（每次重启电脑后要手动起）
```

- **关机/休眠几天**：开机自动补跑**一发**（当天日报）；错过的日期不补文件，但内容不会全丢——HN 抓最近 48h、GitHub 抓最近 7 天，窗口自动覆盖
- **server 电脑重启后不会自启**（有意为之：读报服务不常驻自启，手动起就行；想自启可以把起 server 也加进任务计划或启动项）
- 日报/状态/台账都落在 `12-capstone/daily-brief/reports/`（gitignored）
