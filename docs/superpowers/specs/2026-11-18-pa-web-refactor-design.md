# pa 前端重构设计：组件库 + 管理页 + 会话路由 + SSE 续跑重连

日期：2026-11-18
状态：已批准（2026-11-18 用户批准 Element Plus + 方案B；同日 builder 审查 5 项修正已并入，均为实现路径自决项）

## 意图与为什么

pa 是三阶段的宿主项目（日用个人 agent 工作台），前端目前是「能用的 demo」形态：无路由、无组件库、全手写 CSS，记忆/知识库/技能是聊天页里的滑出小面板，刷新后只能回到最近会话，SSE 断了就丢生成，流式回答期间锁死会话切换。这次把它升级为像样的工作台：管理职责分页、会话可定位可恢复、弱网不丢生成、多会话并行。

## 目标 / 非目标 / 反面目标

**目标**
1. 引入 Element Plus，替换手写的基础控件（按钮/输入/下拉/表格/消息提示等）
2. 记忆 / 知识库 / 技能三个独立管理页（能力平移自现有面板，见「管理页」节）
3. 会话 id 进 URL（`/chat/:id`），刷新后精确回到该会话
4. SSE 异常分级处理 + 服务端续跑真重连（方案B，见「SSE 可靠性」节）
5. 流式回答期间可自由切换会话，后台流继续收，会话列表显示进行中标记

**非目标**
- KB 文档内容在线查看（listKb 无内容字段，需新端点，后补）
- 技能编辑/新建（技能是文件系统目录的职责，页面只读）
- 多用户、鉴权、移动端适配
- OCR 功能本身的变化（仅移入路由页）

**反面目标（做什么都不能破坏的）**
- 确认门安全语义：写入工具必须过确认卡，卡不能比流活得久（宽限期内除外，见下）
- 用户消息不允许因重试而重复落盘
- 半截回答落盘质量：中断/出错的内容必须进账本，不丢已生成的字

## 约束

- 单人本地应用，服务端口 8798，无鉴权
- 现有 API 形状尽量不动，只新增端点
- 仓库单 package.json；`pa:check` 的裸 tsc 不查 .vue script 块——改 .vue 后必须 grep 自查裸用 ref 漏 `.value`（已咬过两次）
- token 纪律：不做全量验证金字塔，代码审查 + 探针验证；验证完停掉自己启动的服务
- 骨架文件创建后立即单独提交（注明待验证）

## 方案对比（讨论结论）

**组件库**：Element Plus（国内最主流、面试认知度最高、管理页组件最全）> Ant Design Vue > Naive UI。已选 Element Plus。

**断开重连深度**：
- 方案A（前端韧性）：预流失败重试 + 中断后拉会话对齐，服务端保持「断开即停」。零服务端风险，但断网期间生成浪费（烧了 token 没人看）。
- 方案B（服务端续跑+重连，**已选**）：断开后服务端继续生成并缓冲帧，宽限期内前端重连同放缓冲帧；宽限期没人回来才 abort+落盘。真·断线不丢生成（合盖/断网唤醒拿完整答案）。代价：动 chat.ts 核心（三种模式+确认门），并反转原「断开即停」省钱设计——用户已明确接受此取舍。

方案A 的「预流重试、中断对齐」作为方案B 的兜底路径保留（服务重启等导致续跑不可能时回落）。

## 设计

### 1. 路由（新增 vue-router 4）

| 路由 | 页面 | 说明 |
|------|------|------|
| `/chat` | ChatPane | 新对话（无 id） |
| `/chat/:id` | ChatPane | 定位到指定会话 |
| `/memory` | MemoryPage | 记忆管理 |
| `/kb` | KbPage | 知识库管理 |
| `/skills` | SkillsPage | 技能索引 |
| `/ocr` | OcrPane | 识别工具（现状平移） |

- AppHeader 改 el-menu（router 模式）；`<router-view>` + keep-alive 包 ChatPane/OcrPane（保持 v-show 不丢状态的语义），管理页不 keep-alive（进页重拉）
- **history 模式**：URL 为干净的 `/chat/:id`；服务端 app.ts 加 SPA fallback 支撑深链（见第 3 节触及文件补充），vite dev 自带 fallback；hash 模式零服务端改动但 URL 带 `/#/`，不取
- 会话切换 = `router.push('/chat/'+id)`；路由参数 watcher 调 `openSession(id)`；新会话收到 session 帧后 `router.replace('/chat/'+sid)`
- 刷新恢复：init 时若有 `:id` 则打开它（不存在则回落 `/chat` + 最近会话），无 `:id` 保持现状（打开最近会话）

### 2. 状态（不引 pinia，模块级单例）

- `useChat` 的状态提到模块作用域（现有代码每次调用新建 ref，路由化后必须提升），对外 API 不变
- 新增 per-session 流注册表：`Map<sid, StreamState>`（controller、placeholder 引用、累计文本）；`messages` 改为按 sid 缓存 `Map<sid, DisplayMessage[]>`（LRU 上限 ~10，挤出非活跃会话）
- `streamingSessions: Set<sid>` 响应式集合驱动 UI：会话列表项转圈标记、对应会话发送按钮禁用；同会话仍被服务端 409 挡（保留）
- 切走的流继续在后台收帧写缓存；切回即见累积内容

### 3. SSE 可靠性（方案B）

**服务端**（server/routes/chat.ts + server/state.ts）：
- 新增 `streamBuffers: Map<sid, { frames: Array<{id, json}>, clients: Set<res>, abortController, graceTimer, postRes }>`；所有帧带自增 `id:` 行（SSE 规范）
- `send()` 改为写缓冲 + 广播到 clients（POST 自己的 res 是初始 client）
- `res.on('close')` 语义变更：不再立即 abort——启动宽限期计时（`PA_GRACE_MS`，默认 90s，env 可配，同 CONFIRM_TIMEOUT_MS 风格）；宽限期内 pendingConfirms 存活（等用户回来点卡）；宽限期到 → abort 上游 + 半截落盘 + 未应答卡按拒绝收尾 + 关闭所有 client + 清缓冲（即现有 close 行为，只是延后触发）
- 新端点 `GET /api/chat/:sid/stream?lastEventId=N`：会话在跑 → 回放缓冲帧（id > N）+ 挂为 live client；会话没在跑 → 发一帧 `{type:'idle'}` 后关闭（客户端据此走对齐路径）
- 新端点 `POST /api/chat/:sid/stop`：abort 会话的 AbortController + 拒绝未应答卡 + 落盘（显式停止，不再依赖客户端断开）
- 新端点 `GET /api/chat/running` → `{sessionIds: string[]}`（builder 审查补充：刷新后前端 streamingSessions 为空，「进行中」标记要活过刷新，必须从服务端发现在跑会话；init 时拉取合并进流注册表）
- 幂等表 `requestIds: Map<requestId, {sid, at}>`（TTL 10 分钟，插入时顺带清扫过期项；客户端预流重试的防重复落盘协议对端）
- 三种模式（normal/plan/composite）统一走新 `send()`，done/error/stopped 后清缓冲、end 所有 client、`runningSessions.delete` 保持 finally 语义
- **触及文件补充**（builder 审查）：server/app.ts 静态中间件加 SPA fallback（非 `/api/*` 且无扩展名的 GET → index.html），否则 vue-router history 模式深链 404；vite dev 自带 history fallback 不用改

**客户端**（web/src/api.ts 重写 streamChat 为流控制器）：

*幂等键（builder 审查修正：原「未收到首帧=未落盘，重发安全」不成立——服务端在流开始前就落盘用户消息，盲目重试必然重复）：*
- 每次 send 生成 `requestId` 随 POST body 上送；服务端维护 `requestIds: Map<requestId, {sid, at}>`（TTL 10 分钟，插入时顺带清扫）
- 收到重复 requestId：该 sid 在跑/宽限中 → 返回 JSON `{ok:true, sessionId, resumed:true}`（不走 SSE），客户端转 GET /stream 续接；已结束 → 返回 `{ok:true, sessionId, resumed:true, done:true}`，客户端走 getSession 对齐
- **预流自动重试只针对连接层失败**（fetch 抛错且一个字节都没收到），带同一 requestId，退避 500ms/1s/2s 共 3 次；服务端返回任何 JSON/HTTP 错误码都不重试，直接展示错误（协议上已不可能重复落盘）

*断线重连（builder 审查修正：原 4 次 ~15s 探完就放弃，比 90s 宽限期早结束，长断线场景拿不到答案）：*
- 首帧后断开 → 快速重连 `GET .../stream?lastEventId=N`：1/2/4/8s 共 4 次
- 快速重连穷尽 → **慢探针**：每 15s 一次 GET /stream，直到续流成功 / 收到 idle（生成已结束 → getSession 对齐）/ 超过 `PA_GRACE_MS + 30s` 上限 → getSession 对齐 + 中断态
- `visibilitychange`/`focus`（合盖唤醒）立即触发一次探针
- placeholder 期间显示「连接中断，服务端仍在生成，自动重连中」
- **停止按钮** = abort 本地 reader + `POST /api/chat/:sid/stop`（不再依赖断开触发服务端停止；会话列表的后台流也用它）

### 4. 管理页（能力平移，不改服务端 API）

- **记忆** MemoryPage：el-table（内容/来源会话/创建时间）+ el-input 前端过滤搜索 + 单条删除 + 清空（ElMessageBox 确认）
- **知识库** KbPage：el-table（名称/分块数/创建时间）+ el-upload（读文本走现有 addKb）+ 单条删除
- **技能** SkillsPage：卡片列表（name/description，只读）
- 聊天页里的 MemoryPanel/KbPanel/SkillPanel 三个滑出面板移除，入口在导航

### 4.5 确认卡全局化（builder 审查提出的多会话缺口）

现在确认卡是活跃会话消息里的模态，后台会话弹卡时用户在别的会话里看不到，120s 超时就被拒绝。多会话并行后这不可接受——改为：

- ConfirmDialog 从 ChatPane 移到 App 壳，作为全局确认宿主：**任何流式会话的待应答卡都全局弹出**，卡面注明所属会话标题，就地应答（`POST /api/chat/confirm` 本就与流无关）
- CONFIRM_TIMEOUT_MS（120s）不变：卡仍受现有超时约束，用户从列表标记看到后台会话在等，来得及就点，来不及按现有语义拒绝
- 点击卡面上的会话名跳转到该会话（router.push）

### 5. Element Plus 组件映射

- ElMessage 替换自研 ToastHost；ElMessageBox 替换 ConfirmDialog（清空记忆等危险操作）
- el-select（模型选择）、el-input（composer textarea、搜索框）、el-tooltip、el-switch（工具开关等）、el-empty（空态）、el-skeleton（加载态）
- 聊天气泡/消息列表保留自定义样式（通用组件库不适合聊天气泡），markdown 渲染复用现有 MarkdownView
- 按需引入（unplugin 方式可选，组件量不大直接全量也可接受，build 时定）

## 留给 build 阶段的决定

- EP 引入方式（unplugin 自动导入 vs 手动）与主题变量对接 styles.css 的方式
- messages LRU 上限具体值、缓冲是否设字节上限（单人应用默认不设）
- 会话列表项「进行中」标记的具体视觉（转圈 vs 呼吸点）

## 风险

- chat.ts 三模式都要适配新 send/close 语义，plan/composite 分支最复杂——实现时逐分支过
- 宽限期内生成在烧 token（用户已接受）；服务重启则续跑不可能，自动回落对齐路径
- 两个标签页开同一会话：GET tail 只读不驱动生成，POST 仍是唯一驱动源，无冲突但回放会重复出现在两个页（可接受）
