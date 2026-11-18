# pa 前端重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** pa 工作台前端升级：Element Plus + vue-router 管理页/会话路由 + SSE 服务端续跑真重连 + 多会话并行流。

**Architecture:** 服务端 chat.ts 增加帧缓冲+多客户端广播+断开宽限期（90s）+requestId 幂等表，新增 stream/stop/running 三端点；前端状态提升为模块单例（按会话缓存消息与流），vue-router history 模式承载会话 id 与管理页，客户端流控制器实现预流幂等重试/快速重连/慢探针/idle 对齐。

**Tech Stack:** Vue 3.5 + Element Plus + vue-router 4；Koa + @koa/router（Node 原生 SSE，无新服务端依赖）。

**Spec:** docs/superpowers/specs/2026-11-18-pa-web-refactor-design.md（实现时 spec 与本计划同读）

## Global Constraints

- 单人本地应用，服务端口 8798，无鉴权；API 形状只新增不修改
- `PA_GRACE_MS` 默认 90_000（env 可配）；客户端探针地平线常量 `PROBE_HORIZON_MS = 120_000`（与默认宽限对齐，注释注明配对关系）
- requestIds 幂等表 TTL 10 分钟；消息缓存 LRU 上限 10
- **不引入测试框架**（用户既定 token 纪律）：per-task 验证 = `npm run check`（服务端）/ `npm run pa:check && npm run pa:build`（web）；SSE 协议正确性由 Task 12 的一次 curl 探针验证；探针完停掉服务，调试日志只进 Temp
- `pa:check` 裸 tsc 不查 .vue script 块——每个改 .vue 的任务在验证步骤加 `.value` 自查：过一遍 diff，setup 顶层 ref 在 script 逻辑里漏 `.value`、template 里多写 `.value` 都是错
- 提交纪律：每任务一提交，中文信息，不加署名尾注
- Element Plus 全量引入（`app.use(ElementPlus)` + `element-plus/dist/index.css`），不配 unplugin

## Review Focus

1. **同 requestId 生成中重放**：重复 POST 必须返回 `{resumed:true}` JSON 而不是再开一轮生成——Task 12 探针步骤 3 验证
2. **lastEventId 非法值**（负数/NaN/超缓冲长）：按 0 处理或 clamp，绝不 500——Task 12 探针步骤 5 验证
3. **停止后不丢字**：stop → 上游 abort + 半截落盘（interrupted）+ `{type:'stopped'}` 帧——Task 12 探针步骤 4 验证
4. **深链到不存在的会话**：回落 `/chat` + 最近会话，不白屏——Task 12 探针步骤 6（浏览器）验证
5. **刷新后「进行中」标记存活**：宽限期内 GET /api/chat/running 必须报出在跑会话——Task 12 探针步骤 2 验证

---

### Task 1: 依赖安装 + 服务端 SPA fallback

**Files:**
- Modify: `personal-agent/server/app.ts:73-86`（静态中间件）
- Modify: 根 `package.json`（npm 安装自动改）

**Interfaces:**
- Produces: 深链 `GET /chat/xxx` 等非 `/api` 无扩展名路径返回 `index.html`（Task 2 的 history 路由依赖）

- [ ] **Step 1: 安装前端依赖**

```bash
npm i element-plus vue-router
```

- [ ] **Step 2: app.ts 静态中间件加 SPA fallback**

`readStatic` 返回 null 时不直接落到 404：若路径最后一段不含 `.`（无扩展名）且非 `/api`，改读 `index.html` 返回（复用现有 mime/Cache-Control 逻辑）。目录穿越防护沿用现有实现（fallback 读的是 PUBLIC_DIR/index.html，天然安全）。404 兜底注释同步更新（「没这个文件」只剩带扩展名的路径）。

- [ ] **Step 3: 类型检查**

Run: `npm run check`
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "pa：安装 element-plus/vue-router，静态中间件加 SPA fallback 支撑 history 深链"
```

### Task 2: Element Plus 接入 + 路由骨架 + App 壳改造

**Files:**
- Create: `personal-agent/web/src/router/index.ts`
- Create: `personal-agent/web/src/pages/MemoryPage.vue`、`KbPage.vue`、`SkillsPage.vue`（stub：`<el-empty description="建设中" />`，Task 9-11 实装）
- Modify: `personal-agent/web/src/main.ts`、`App.vue`、`components/common/AppHeader.vue`
- Modify: `personal-agent/web/src/utils/toast.ts`（实现改为委托 ElMessage，导出签名不变）
- Delete: `personal-agent/web/src/components/common/ToastHost.vue`（App.vue 里移除挂载；先确认无其他 import）

**Interfaces:**
- Produces: `router/index.ts` 导出 `router`（createWebHistory 实例）；路由表：`/chat`（ChatPane）、`/chat/:id`、`/memory`、`/kb`、`/skills`、`/ocr`（OcrPane）
- Produces: ChatPane/OcrPane 加 `defineOptions({ name: 'ChatPane' })`/`'OcrPane'`（keep-alive include 依赖命名）

- [ ] **Step 1: 写 router/index.ts**

createWebHistory；六条路由；管理页三条先指向 stub。懒加载不必要（个人工具全量打包）。

- [ ] **Step 2: main.ts / App.vue / AppHeader.vue 改造**

main.ts：`app.use(router)` + import EP css + `app.use(ElementPlus)`。
App.vue：AppHeader 保留但不再传 `pane` prop；视图区换 `<router-view v-slot="{ Component }"><keep-alive :include="['ChatPane','OcrPane']"><component :is="Component" /></keep-alive></router-view>`；移除 ToastHost。
AppHeader.vue：改 el-menu（`:router="true"`、`:default-active="route.path"`、horizontal、menu-trigger 不需要）；菜单项 index=路由路径；删除 pane/emit 逻辑。原 `.app-body` 布局类保留在 App.vue。

- [ ] **Step 3: toast 门面切换 + 删 ToastHost**

utils/toast.ts 内部实现换 ElMessage（success/error/info 映射），调用方（useChat 等）零改动。

- [ ] **Step 4: ChatToolbar / ChatComposer 控件 EP 化**

ChatToolbar.vue：模型选择换 el-select、工具/开关类换 el-switch、悬停说明包 el-tooltip；ChatComposer.vue：textarea 换 el-input `type="textarea"`（行数/禁用态 props 对应现状）。仅换控件不换交互逻辑，自定义样式类保留。

- [ ] **Step 5: 类型检查 + 构建**

Run: `npm run pa:check && npm run pa:build`
Expected: 双双通过

- [ ] **Step 6: .value 自查**

过一遍本次 .vue diff：script 逻辑里的 ref 漏 `.value`、template 里多余的 `.value`。

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "pa：EP 接入+路由骨架（六路由/keep-alive/管理页 stub）+toast 换 ElMessage"
```

### Task 3: chat 状态模块单例化 + 多会话并行流

**Files:**
- Modify: `personal-agent/web/src/composables/useChat.ts`（重写内部结构，导出 API 见 Interfaces）
- Modify: `personal-agent/web/src/components/chat/SessionSidebar.vue`（进行中标记）

**Interfaces:**
- Produces（模块级，useChat 每次调用返回同一份）:
  - `messagesBySid: Map<string | null, DisplayMessage[]>`（null = 尚未落库的新对话；LRU 上限 10，挤出最旧的非活跃非流式会话）
  - `activeSid: Ref<string | null>`（当前打开的会话）
  - `streamingSessions: Set<string>`（reactive；进行中集合，多会话并行的事实源）
  - `messages: ComputedRef<DisplayMessage[]>`（= messagesBySid.get(activeSid) ?? []，旧导出名保留）
  - `streaming: ComputedRef<boolean>`（= activeSid 在 streamingSessions 中）
  - `runs: Map<string | null, { controller: AbortController; placeholder: DisplayMessage }>`（进行中流的本地句柄，键同 messagesBySid）
- 行为变化：`openSession`/`newChat` 不再被 streaming 挡（删掉两处 toast 守卫）；`send` 只挡「当前会话已在 streamingSessions」

- [ ] **Step 1: 重写 useChat.ts 状态层**

state 全部提到模块作用域（单例）；`send` 里 placeholder/acc/controller 收进 `runs`，帧回调改为写 `messagesBySid` 里对应键的 placeholder；session 帧把 null 键 rekey 成真实 sid 并同步挪 `runs`。`init()` 保持现状逻辑（Task 4 接管深链）。ChatPane 等调用方导出名不变。

- [ ] **Step 2: SessionSidebar 进行中标记**

会话项右侧：`streamingSessions.has(s.id)` 时显示一个转圈标记（el-icon Loading 或纯 CSS spinner），无新 API。

- [ ] **Step 3: 类型检查 + 构建**

Run: `npm run pa:check && npm run pa:build`
Expected: 双双通过

- [ ] **Step 4: .value 自查**

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "pa：chat 状态提升模块单例，多会话并行流（切会话不再中断回答）+列表进行中标记"
```

### Task 4: 会话 id ↔ 路由绑定（刷新定位）

**Files:**
- Create: `personal-agent/web/src/composables/useSessionRoute.ts`
- Modify: `personal-agent/web/src/composables/useChat.ts`、`components/chat/ChatPane.vue`

**Interfaces:**
- Consumes: `router`（from `../router`）
- Produces: `useSessionRoute(): void`——在 ChatPane setup 里调一次：
  - watch `route.params.id`：有值 → `openSession(id)`；无值 → `newChat()`
  - useChat 内部 `router.replace('/chat/' + sid)`（session 帧创建新会话时）、`newChat()` 改为 `router.push('/chat')`、`init()` 深链逻辑：route 有 `:id` → openSession（失败/404 → `router.replace('/chat')` 后打开最近会话）；无 → 现状（打开最近）
- 环路防护：watcher 触发的 openSession 不再回写路由（route 是唯一事实源，openSession 不 push）

- [ ] **Step 1: 写 useSessionRoute.ts + useChat 路由化**

- [ ] **Step 2: ChatPane.setup 调 useSessionRoute()**

- [ ] **Step 3: 类型检查 + 构建**

Run: `npm run pa:check && npm run pa:build`
Expected: 通过

- [ ] **Step 4: .value 自查**

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "pa：会话 id 进 URL（/chat/:id 刷新定位，深链 404 回落最近会话）"
```

### Task 5: 服务端帧缓冲 + 广播 + 宽限期 + 幂等表

**Files:**
- Modify: `personal-agent/server/state.ts:102` 后追加
- Modify: `personal-agent/server/routes/chat.ts`（POST /api/chat 重构）
- Modify: `personal-agent/server/chat-service.ts`（ChatBody 加 `requestId?: string`）

**Interfaces:**
- Produces（state.ts 导出）:
```ts
export const PA_GRACE_MS = Number(process.env.PA_GRACE_MS || 90_000)
export interface StreamFrame { id: number; json: string }
export interface StreamBuffer {
  frames: StreamFrame[]
  clients: Set<ServerResponse>            // 含 POST 自身的 res
  postRes: ServerResponse                  // POST 的 res——close 时区分谁断了
  abort: AbortController
  graceTimer: NodeJS.Timeout | null
  nextId: number
}
export const streamBuffers = new Map<string, StreamBuffer>()
export const requestIds = new Map<string, { sid: string; at: number }>()
export const REQUEST_ID_TTL_MS = 10 * 60_000
```

- [ ] **Step 1: state.ts 追加以上导出**（`import type { ServerResponse } from 'node:http'`）

- [ ] **Step 2: chat.ts POST /api/chat 重构**

关键点（顺序敏感）：
1. **幂等检查放在 `store.load/create` 之前**：body 带 requestId 且命中 `requestIds` → `json(ctx, 200, { ok: true, sessionId: seen.sid, resumed: true, done: !streamBuffers.has(seen.sid) })`，直接返回
2. 会话创建后（append 前）：`requestIds.set(requestId, { sid, at: Date.now() })` + 顺带清扫过期项（遍历删 `at + TTL < now`）
3. `AbortController` 提前到 SSE 头之前创建；建 `buf`（`clients: new Set([res])`, `postRes: res`）并 `streamBuffers.set(sid, buf)`
4. `send(o)` 重写：`const id = buf.nextId++; const jsonStr = JSON.stringify(o); buf.frames.push({ id, json: jsonStr }); const line = 'id: ' + id + '\ndata: ' + jsonStr + '\n\n'; for (const c of buf.clients) { if (!c.destroyed && !c.writableEnded) c.write(line) }`
5. `res.on('close')` 重写：`res !== buf.postRes` → 仅 `clients.delete(res)`；是 postRes 且 `!res.writableEnded` 且 `streamBuffers.get(sid) === buf` → 设 `buf.graceTimer = setTimeout(graceExpire, PA_GRACE_MS)`（不再立即 abort）
6. `graceExpire()`：`streamBuffers.get(sid) !== buf` 直接 return（已正常收尾/已重连清过）；`ac.abort()`；现有「未应答卡按拒绝收尾」循环；`saveInterrupted(Date.now() - t0)`；`finish()`
7. `finish()`：`clearTimeout(buf.graceTimer)`；`streamBuffers.delete(sid)`；对 `buf.clients` 逐个 `c.end()`。**替换**原函数尾部裸 `res.end()`
8. abort 落盘路径（`result.aborted || ac.signal.aborted` 分支及 catch 的 aborted 分支）在 `saveInterrupted` 前补 `send({ type: 'stopped' })`（活着的 tail 客户端要知道停了）
9. done/error 正常路径末尾调用 `finish()`（帧先发完再 finish——send 都在 finish 之前）
10. finally `runningSessions.delete(sid)` 保持不变

- [ ] **Step 3: 类型检查**

Run: `npm run check`
Expected: 通过

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "pa 服务端：SSE 帧缓冲+多客户端广播+断开宽限期(PA_GRACE_MS=90s)+requestId 幂等表"
```

### Task 6: 服务端三端点 stream / stop / running

**Files:**
- Create: `personal-agent/server/routes/chat-stream.ts`
- Modify: `personal-agent/server/app.ts`（挂载新 router，chatRouter 之后）

**Interfaces:**
- Consumes: state.ts 的 `streamBuffers`/`PA_GRACE_MS`/Task 5 的缓冲结构
- Produces:
  - `GET /api/chat/running` → `{ sessionIds: string[] }`
  - `GET /api/chat/:sid/stream?lastEventId=N` → SSE：回放 id>N 的缓冲帧 + 挂为 live client；会话不在跑 → `data: {"type":"idle"}\n\n` 后 end
  - `POST /api/chat/:sid/stop` → 有缓冲：`buf.abort.abort()` 后 `{ ok: true }`；无缓冲：404 `{ error: '该会话没有进行中的回答' }`

- [ ] **Step 1: 写 chat-stream.ts**

GET /stream 用 chat.ts 同款「接管原生 res」配方（`ctx.respond = false` + writeHead SSE 三件套头）。`lastEventId` 解析：`Math.max(0, Number.parseInt(String(ctx.query.lastEventId ?? '0'), 10) || 0)`（NaN/负数全落 0；越界由 slice 语义天然 clamp）。回放后 `buf.clients.add(res)`、清 `graceTimer`（有人回来了）、`res.on('close', () => buf.clients.delete(res))`。
`GET /running` 路由注册在 `:sid/stream` 之前无冲突（段数不同），但放文件顶部清晰。

- [ ] **Step 2: app.ts 挂载**

- [ ] **Step 3: 类型检查**

Run: `npm run check`
Expected: 通过

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "pa 服务端：新增 SSE 续接(stream)/显式停止(stop)/在跑发现(running)三端点"
```

### Task 7: 客户端流控制器重写 + 重连协议全套

**Files:**
- Modify: `personal-agent/web/src/api.ts`（streamChat 重写 + 两个新函数）
- Modify: `personal-agent/web/src/types.ts`（`ChatRequest.requestId?: string`、`DisplayMessage.reconnecting?: boolean`、新 `StreamStatus`/`StreamResult` 类型）
- Modify: `personal-agent/web/src/composables/useChat.ts`（接入新协议）

**Interfaces:**
- Produces（api.ts）:
```ts
export type StreamStatus = 'connecting' | 'streaming' | 'reconnecting' | 'aligning'
export interface StreamHandlers { onChunk(c: ChatChunk): void; onStatus(s: StreamStatus): void }
export interface StreamResult { sessionId: string; outcome: 'done' | 'aligned' | 'stopped' }
export async function streamChat(body: ChatRequest, handlers: StreamHandlers, signal?: AbortSignal): Promise<StreamResult>
export async function fetchRunningSessions(): Promise<string[]>
export async function stopSession(sid: string): Promise<void>
```
- Consumes: Task 5/6 全部服务端行为

- [ ] **Step 1: api.ts 流控制器**

算法（常量钉死：预流重试 3 次退避 500/1000/2000ms，仅连接层失败；快速重连 4 次 1/2/4/8s；慢探针 15s 间隔、地平线 `PROBE_HORIZON_MS = 120_000`；这些都写成模块常量）：
1. `body.requestId` 缺省补 `crypto.randomUUID()`
2. POST 循环：fetch 抛错且零字节 → 退避重试（≤3 次）；若响应是 JSON 且 `resumed: true` → `done === true` 直接 `return { sessionId, outcome: 'aligned' }`，否则跳到「续接循环」（用返回的 sessionId）
3. SSE 解析循环（现有实现基础上加 `id:` 行解析记录 `lastEventId`；session 帧把 sid 交给外部 via onChunk）
4. 流中断（read 抛错/流提前 end 且没收到 done/error 帧）：signal.aborted → `{outcome:'stopped'}`；否则进入续接循环：快速 4 次失败 → 慢探针（15s 间隔，超地平线放弃）；每次 GET /stream 连上就继续现有解析循环（服务端已按 lastEventId 去重回放）
5. 收到 `idle` 帧 / 地平线耗尽 / GET 404 → `getSession(sid)` 拉全量（**outcome: 'aligned'**，调用方负责用 detail 覆盖本地缓存）；期间持续 `onStatus('reconnecting' | 'aligning')`
6. 慢探针期间监听 `visibilitychange`/`focus` 事件，触发时立即插一次探针（合盖唤醒场景，设计稿 §3 明确要求）
7. error 帧处理：保持现状（抛错由调用方展示，消息已在服务端落盘）；**只有连接层失败**才走 aligned 对齐路径

- [ ] **Step 2: types.ts 类型补充**

- [ ] **Step 3: useChat.ts 接入**

- `send()`：handlers.onStatus('reconnecting') → `placeholder.reconnecting = true`（'streaming' 时置回 false）；outcome 'aligned' → `getSession(sid)` 全量覆盖 `messagesBySid` 该键 + `placeholder.streaming = false`；'stopped' → 现有 interrupted 标记逻辑；onStatus('connecting')
- `stop()`：`activeSid` 非空 → `void stopSession(sid)`（网络调用失败不 toast，本地 abort 兜底）+ 现有 `controller.abort()`
- `init()`：`listSessions` 后 `fetchRunningSessions()` 并入 `streamingSessions`
- MessageItem/ChatPane：placeholder 带 `reconnecting` 时消息气泡上显示「连接中断，服务端仍在生成，自动重连中」条（el-alert 或一行文案，样式从简）

- [ ] **Step 4: 类型检查 + 构建**

Run: `npm run pa:check && npm run pa:build`
Expected: 通过

- [ ] **Step 5: .value 自查**

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "pa 前端：流控制器重写——预流幂等重试/快速重连/慢探针/idle 对齐/显式停止接入"
```

### Task 8: 确认卡全局化

**Files:**
- Modify: `personal-agent/web/src/composables/useChat.ts`、`components/chat/ChatPane.vue`、`components/chat/ConfirmDialog.vue`
- Create: `personal-agent/web/src/components/chat/ConfirmHost.vue`

**Interfaces:**
- Produces: useChat 导出 `globalConfirm: Ref<{ sid: string; title: string; card: ConfirmCard } | null>`——confirm 帧写入、outcome 帧/应答后清除；ConfirmHost.vue 挂在 App.vue，读它渲染 ConfirmDialog 同款卡（+会话标题行，点击标题 `router.push('/chat/'+sid)`）

- [ ] **Step 1: 先读 ChatPane.vue 现有确认卡接线**

- [ ] **Step 2: useChat 维护 globalConfirm（confirm 帧 set / outcome 或本地应答后 clear）**

- [ ] **Step 3: ConfirmHost.vue + App.vue 挂载；ChatPane 移除模态（消息内芯片保留）**

- [ ] **Step 4: 类型检查 + 构建 + .value 自查**

Run: `npm run pa:check && npm run pa:build`

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "pa：确认卡全局化——后台会话的写入门全局弹出，卡面带会话标题可跳转"
```

### Task 9: 记忆管理页

**Files:**
- Modify: `personal-agent/web/src/pages/MemoryPage.vue`（替换 stub）
- Modify: `personal-agent/web/src/types.ts`（如 MemoryItem 字段不足以支撑表格列，以实际类型为准）

**Interfaces:**
- Consumes: api.ts 现有 `listMemories`/`deleteMemory`/`clearMemories`

- [ ] **Step 1: 实装页面**

onMounted 拉 `listMemories`；el-table（内容 / 创建时间列——MemoryItem 实际字段照 types.ts 为准）+ el-input 搜索框前端过滤 + 行删除（ElMessageBox 确认）+ 顶部「清空全部」（ElMessageBox.confirm 强确认）；空态 el-empty；加载中 el-skeleton。删除/清空后本地重拉。

- [ ] **Step 2: 类型检查 + 构建 + .value 自查**

Run: `npm run pa:check && npm run pa:build`

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "pa：记忆管理页（列表/搜索/删除/清空，EP 表格）"
```

### Task 10: 知识库管理页

**Files:**
- Modify: `personal-agent/web/src/pages/KbPage.vue`

**Interfaces:**
- Consumes: api.ts 现有 `listKb`/`addKb`/`deleteKb`

- [ ] **Step 1: 实装页面**

el-table（名称/分块数/创建时间——KbDoc 无内容字段，不提供在线查看，设计非目标）+ 上传：el-upload（`:auto-upload="false"` + 手动读文本走 `addKb(name, text)`；沿用现 KbPanel 的 100KB 上限与 PDF 拒收逻辑）+ 行删除（确认框）。空态/加载态同 Task 9 风格。

- [ ] **Step 2: 类型检查 + 构建 + .value 自查**

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "pa：知识库管理页（列表/上传/删除，EP 表格+上传）"
```

### Task 11: 技能管理页

**Files:**
- Modify: `personal-agent/web/src/pages/SkillsPage.vue`

**Interfaces:**
- Consumes: api.ts 现有 `listSkills`

- [ ] **Step 1: 实装页面**

只读卡片列表（name/description，el-card 网格），空态/加载态同前。页面顶部一行说明文案：「技能在对话里经 use_skill 加载，此处为索引」（types.ts SkillInfo 注释同义）。

- [ ] **Step 2: 类型检查 + 构建 + .value 自查**

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "pa：技能索引页（只读卡片列表）"
```

### Task 12: 清理 + 探针验证 + 收尾

**Files:**
- Delete: `personal-agent/web/src/components/chat/MemoryPanel.vue`、`KbPanel.vue`、`SkillPanel.vue`（先确认无 import 残留）
- Modify: `personal-agent/web/src/styles.css`（删除确认无引用的旧面板样式，克制——不确定引用的就留）

**Interfaces:**
- Consumes: 全部前序任务

- [ ] **Step 1: 删旧面板 + 清样式 + pa:check/pa:build 通过**

```bash
grep -rn "MemoryPanel\|KbPanel\|SkillPanel\|ToastHost" personal-agent/web/src --include="*.vue" --include="*.ts"
```
Expected: 无输出后删文件。

- [ ] **Step 2: 启动服务跑 SSE 协议探针**（探针完停服务，覆盖 Review Focus 5 项）

```bash
npm run pa &   # 或后台启动，端口 8798
```
1. 深链：`curl -s http://127.0.0.1:8798/chat/whatever | head -5` → 返回 index.html（SPA fallback 生效）
2. 发起一条短对话（curl POST /api/chat 一句「你好」，模型真实回答），第 3 秒 kill 掉 curl（模拟断开）→ 立刻 `curl http://127.0.0.1:8798/api/chat/running` → 含该 sid（宽限期续跑中）
3. 同 requestId 重放：重发同一 body（含同 requestId）→ 返回 `{resumed:true}` JSON，且会话列表没有多出新会话
4. `POST /api/chat/<sid>/stop` → `GET /api/sessions/<sid>`：assistant 消息带 `interrupted: true`（半截落盘）；GET /stream 此时报 idle
5. `GET /api/chat/<sid>/stream?lastEventId=-5`、`lastEventId=abc`、`lastEventId=99999` → 全部正常响应（按 0 或 clamp），无 500
6. 浏览器打开 `http://127.0.0.1:8798/chat/不存在id` → 回落最近会话不白屏；刷新带真实 sid 的 URL → 定位同会话；流式回答中切到另一会话 → 原会话列表项转圈、切回见累积文本
7. 探针毕：停服务，确认 8798 无监听

- [ ] **Step 3: PII 自查**

```bash
git diff <起点commit>..HEAD -- personal-agent | grep -inE "sk-[a-zA-Z0-9]{8,}|api[_-]?key\s*[:=]\s*['\"][^'\"]{8,}|1[3-9][0-9]{9}" | head -20
```
Expected: 无真实密钥/手机号命中（docs/plans 不扫）

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "pa：移除旧滑出面板与冗余样式，重构收尾"
```

- [ ] **Step 5: 全分支代码审查**

用 superpowers:requesting-code-review 对整个重构分支做一次新鲜视角审查（本计划唯一的独立审查关，弥补无测试金字塔），发现按严重度修复后重跑 pa:check/pa:build。
