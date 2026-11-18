# 会话 SQLite 索引 + 分页 + 删除 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 会话列表元数据进 SQLite 索引（分页 O(1)），侧栏加删除与「加载更多」，消息 JSON 文件与图片目录零改动。

**Architecture:** 新建 `core/session-index.ts`（better-sqlite3 索引层，指纹对账兜底）；`createSessionStore` 写路径同步维护索引、`list()` 走 SQL 分页；路由加分页参数与删除 409 守卫；web 侧 useChat 分页状态（refresh 保窗整窗替换）+ 深链修正 + 侧栏删除/加载更多 UI。

**Tech Stack:** better-sqlite3（已在依赖树，补 @types）+ Koa + Vue 3.5 + Element Plus

**Spec:** docs/superpowers/specs/2026-11-18-pa-session-index-design.md（已批准，含 builder check 裁定）

## Global Constraints

- 不引测试框架（token 纪律）：验证关 = per-task tsc 门 + curl/浏览器探针；服务端门 = `npm run check` 全量 error TS 列表对基线零新增（基线在执行 setup 时重采，当前 ~29 条全在 langChain 等学习脚本、personal-agent/server 零 error）；web 门 = `pa:check` + `pa:build` 双绿
- master 直连执行（单人仓库惯例）
- 索引是缓存不是事实源：事实源始终是 JSON 文件；索引可随时删库重建（指纹对账自动补齐）
- 原子写语义（.tmp→rename）与图片目录布局不变
- better-sqlite3 是同步 API；WAL 模式；库文件 `<dataDir>/sessions.index.db`
- 提交信息中文、`pa：` 前缀（仓库惯例）；构建产物 public/assets 随源码一并提交

## Review Focus

1. **分页窗口被发送折叠**：refresh 有五个调用点（发送/流完/后台跑完/删除/init）——必须保窗整窗替换（重拉 `[0, 已加载数)`），绝不清回第一页——Task 4 探针：loadMore 后触发一次 refresh，sessions.length 不缩
2. **索引与文件漂移**：手工改/删 JSON 文件后列表必须反映真实（指纹 mtime+size 对账；孤儿行删除）——Task 2 探针：改文件内容不碰索引 → list 看到新标题；删文件 → total 减一
3. **删除在跑会话的竞态**：DELETE 守卫必须同时查 `runningSessions.has(sid) || streamBuffers.has(sid)`（宽限期内 buffer 还活着，漏查 streamBuffers 会让生成往已删会话落盘）——代码审查项，不烧 token 造 running 态
4. **深链到不在首页的旧会话**：分页后 wanted id 不能拿首页列表验证（会误判不存在）——Task 4 探针：直接打开第 40 条旧会话成功
5. **limit/offset 非法值**（负数/NaN/超大）：钳制，绝不 500——Task 3 探针：limit=-5/abc/9999、offset=-1 都返回 200

---

### Task 1: session-index 模块

**Files:**
- Create: `personal-agent/core/session-index.ts`
- Modify: `package.json`（devDependencies 加 `@types/better-sqlite3`）

**Interfaces:**
- Consumes: `SessionDoc`（core/sessions.ts 导出：`{id, title, updatedAt, messages}` 够用）
- Produces: `SessionIndex` 接口——`list(limit: number, offset: number): { rows: IndexRow[]; total: number }`；`upsert(row: IndexRow): void`；`remove(id: string): void`；`reconcile(sessionsDir: string, loadDoc: (id: string) => Promise<SessionDoc | null>): Promise<void>`；`close(): void`；`createSessionIndex(dbPath: string): SessionIndex`；`IndexRow = { id: string; title: string; updatedAt: string; messageCount: number; mtimeMs: number; size: number }`

- [ ] **Step 1: 装 @types/better-sqlite3**（`--legacy-peer-deps`；better-sqlite3 本体已在依赖树）
- [ ] **Step 2: 实现 `createSessionIndex`**：表 `sessions_index(id TEXT PRIMARY KEY, title TEXT, updated_at TEXT, message_count INTEGER, mtime_ms INTEGER, size INTEGER)`；WAL；`list` 按 `updated_at DESC` 排序 + `COUNT(*)` 总数；`reconcile` 读目录 `.json` 文件 stat 指纹比对——一致的跳过、不一致/缺失的 `loadDoc` 后 upsert、索引里有而文件没有的行删除
- [ ] **Step 3: 零 token 冒烟探针**（临时脚本，$TEMP 下）：临时目录建索引 → upsert 两行 → list 断言顺序与 total → remove 一行 → reconcile 对「文件已删」场景断言行清掉。跑通后删脚本
- [ ] **Step 4: 门**——`npm run check` 对基线零新增
- [ ] **Step 5: Commit**——`pa：会话索引模块（SQLite 元数据层，指纹对账）`

### Task 2: store 集成

**Files:**
- Modify: `personal-agent/core/sessions.ts`

**Interfaces:**
- Consumes: Task 1 的 `createSessionIndex` / `IndexRow`
- Produces: `SessionStore.list` 签名变更——`list(opts?: { limit?: number; offset?: number }): Promise<{ sessions: SessionSummary[]; total: number }>`（默认 limit=50, offset=0）；其余接口不变

- [ ] **Step 1: store 持索引**：`createSessionStore(dataDir)` 内建 `createSessionIndex(path.join(dataDir, 'sessions.index.db'))`；惰性 reconcile（首次 `list` 前跑一次，promise 缓存防重复）
- [ ] **Step 2: `save()` 单点维护**：save 成功后 stat 文件指纹 + 从 doc 取 title/updatedAt/messages.length upsert（create/append/setSummary 都汇经 save，一个 upsert 点覆盖全部写路径）；`remove()` 追加 `index.remove(id)`
- [ ] **Step 3: `list()` 改走 SQL**：opts 钳制（limit 缺省 50、offset 缺省 0）→ `index.list` → `{sessions, total}`
- [ ] **Step 4: 探针**（$TEMP dataDir）：create×3 → list({limit:2}) 断言 2 行 + total 3 + 排序；append 后 list 的 messageCount/updatedAt 更新；remove 后 total 2。**漂移探针**：手工 fs 改某文件 title → 重建 store 后 list 见新标题；手工删文件 → total 反映
- [ ] **Step 5: 门**——`npm run check` 零新增（注意 probe.ts 等既有 list() 调用方的编译适配）
- [ ] **Step 6: Commit**——`pa：store 接入会话索引（list 分页化，写路径单点维护）`

### Task 3: 路由分页 + 删除守卫

**Files:**
- Modify: `personal-agent/server/routes/sessions.ts`

**Interfaces:**
- Consumes: Task 2 的 `list(opts)`；state.ts 既有 `runningSessions` / `streamBuffers`
- Produces: `GET /api/sessions?limit=&offset=` → `{sessions, total}`（limit 钳 1~200、offset 钳 ≥0，解析失败回缺省）；`DELETE /api/sessions/:id` 在跑时 409 `{error:'会话正在回答，先停止再删除'}`

- [ ] **Step 1: GET 加参数**（query 解析 + 钳制）
- [ ] **Step 2: DELETE 守卫**（RunningSessions ∪ streamBuffers 双查；通过后逻辑不变）
- [ ] **Step 3: curl 探针**（PA_PORT=8799 独立实例，完事必停）：`limit=5` → 5 行 + total；`limit=-5/abc/9999`、`offset=-1` → 全部 200；POST 建一次性会话 → DELETE → total 减一；再 DELETE 同 id → 200（幂等容忍，既有语义不动）
- [ ] **Step 4: 门**——`npm run check` 零新增
- [ ] **Step 5: Commit**——`pa：会话路由分页参数 + 在跑会话删除守卫（runningSessions/streamBuffers 双查）`

### Task 4: web 分页状态 + 深链修正

**Files:**
- Modify: `personal-agent/web/src/api.ts`、`personal-agent/web/src/types.ts`、`personal-agent/web/src/composables/useChat.ts`

**Interfaces:**
- Consumes: Task 3 的 `{sessions, total}` 响应形状
- Produces: `listSessions(limit = 30, offset = 0): Promise<{ sessions: SessionSummary[]; total: number }>`；useChat 新导出——`total: Ref<number>`、`hasMore: ComputedRef<boolean>`、`loadMoreSessions(): Promise<void>`、`deleteSession(id: string): Promise<boolean>`（false=409 被拒）；`refreshSessions()` 语义变更为「重拉 `[0, sessions.value.length)` 整窗替换」

- [ ] **Step 1: api.ts/types.ts**——`listSessions` 加参数；payload 类型 `{ sessions: SessionSummary[]; total: number }`
- [ ] **Step 2: useChat**——状态 `total`/`hasMore = computed(sessions.length < total)`；`loadMoreSessions()` 追加下一页（offset=sessions.length）；`refreshSessions()` 改整窗替换（保窗不折叠——设计稿裁定，防发送折叠回归）；`deleteSession(id)`：DELETE → 200 整窗重拉（删的是 activeSid → newChat）返回 true；409 toast「会话正在回答，先停止」返回 false
- [ ] **Step 3: 深链修正**——`init()` 删掉 wanted-首页验证逻辑（路由 watcher 是唯一事实源）；`openSession` 的 catch 分支接手坏 id：toast + `router.replace('/chat/' + sessions[0].id)`（无会话则 `/chat`），保持路由为唯一事实源
- [ ] **Step 4: 探针**（playwright，8799 实例，完事必停）：①深链打开排序 30 名开外的旧会话 → 正常打开不回落（分页外 id 修复验证）②保窗验证：点「加载更多」展开到 40 条 → curl POST /api/sessions 造一条一次性会话 → 在 UI 里删掉它（触发 refreshSessions）→ 侧栏仍保持 ~40 条不折叠回 30
- [ ] **Step 5: 门**——`pa:check` + `pa:build`
- [ ] **Step 6: Commit**——`pa：web 会话分页状态（refresh 保窗整窗替换）+ 深链修正（不依赖首页验证）`

### Task 5: 侧栏删除与加载更多 UI

**Files:**
- Modify: `personal-agent/web/src/components/chat/SessionSidebar.vue`、`personal-agent/web/src/components/chat/ChatPane.vue`

**Interfaces:**
- Consumes: Task 4 的 `deleteSession/loadMoreSessions/hasMore/total/streamingSessions`
- Produces: 侧栏项 hover 浮出删除图标（EP `Delete` 图标，streamingSessions 命中时禁用+title 提示）；ElMessageBox.confirm 确认后 emit delete；底部 `加载更多（n/total）` 按钮（hasMore 时显示）emit load-more；ChatPane 接线两个 emit

- [ ] **Step 1: SessionSidebar**——列表项结构加删除按钮（hover 显形）；confirm 文案「删除会话「标题」？不可恢复」；在跑项按钮 disabled
- [ ] **Step 2: ChatPane 接线**——`@delete="deleteSession"` `@load-more="loadMoreSessions"`；侧栏 props 加 `hasMore`/`total`
- [ ] **Step 3: 浏览器探针**（8799，playwright 截图+交互）：hover 出删除钮 → 点删 → 确认弹窗 → 行消失、total 减一；删除当前打开会话 → 跳回新对话；「加载更多」点击追加。完事必停实例
- [ ] **Step 4: 门**——`pa:check` + `pa:build`
- [ ] **Step 5: Commit**——`pa：侧栏会话删除（确认弹窗/在跑禁删）+ 加载更多分页按钮`

### Task 6: 收尾

**Files:**
- Modify: `personal-agent/public/assets/`（构建产物）

- [ ] **Step 1: 全量门**——`npm run check` 基线 diff 零新增；`pa:check` + `pa:build` 绿
- [ ] **Step 2: 提交构建产物**——`pa：pa:build 产物随会话索引功能更新`
- [ ] **Step 3: 台账收尾**——探针结果、Ruling、deferred 汇总进台账；确认 8799 等自起实例全停（8798 用户产线不动）
