# pa 会话索引与分页删除 设计稿（2026-11-18）

## 意图与动机

会话数量会持续增长（现在 51 个）。现状三个痛点：

1. **列表慢的根**：`createSessionStore.list()` 每次把所有会话 JSON 全量 parse（每个文件含全部消息），只为拿 title/updatedAt/messageCount 四个字段
2. **无删除入口**：服务端 `DELETE /api/sessions/:id` 与 `store.remove()` 早已存在，界面没有按钮
3. **无分页**：列表一次全吐，会话多了侧栏和接口都受不了

## 方案取舍（用户已选 A）

- **A. SQLite 只做索引，账本留文件（选定）**：索引表管列表/分页/排序，消息内容仍在 JSON 文件；写路径同步维护索引，启动对账兜底
- B. 侧车 meta 文件——穷人版，没有 SQL 的灵活性，一致性复杂度没省
- C. 全量迁 SQLite（消息进库）——单人应用收益配不上迁移风险，放弃

## 目标

- 列表接口分页（limit/offset + total），列表不再全量 parse 消息
- 侧栏：分页加载（「加载更多」）+ 删除（确认弹窗，复用管理页 ElMessageBox 模式）
- 删除边界：在跑会话拒绝删除（服务端 409 + UI 提示先停止）

## 非目标 / 反目标

- 非目标：消息全文进库、标题搜索、会话重命名（SQL 索引在，以后加搜索是一行 LIKE 的事，不进本次）
- 非目标：迁移历史消息到数据库
- 反目标：破坏既有原子写语义（.tmp→rename）与图片目录布局；一次性大迁移

## 约束

- 不引测试框架（token 纪律，验证 = tsc 门 + 探针）
- better-sqlite3 已在依赖树（langChain 引入），补 @types/better-sqlite3；同步 API
- master 直连执行

## 设计

### 存储：`core/session-index.ts`（新）

```ts
export interface SessionIndex {
  list(limit: number, offset: number): { rows: IndexRow[]; total: number }
  upsert(row: IndexRow): void        // INSERT OR REPLACE
  remove(id: string): void
  /** 启动对账：按 (mtimeMs, size) 指纹比对，不一致的文件重读重灌，孤儿行删除 */
  reconcile(sessionsDir: string, loadDoc: (id: string) => Promise<SessionDoc | null>): Promise<void>
  close(): void
}
// IndexRow = { id, title, updatedAt, messageCount, mtimeMs, size }
```

- 库文件：`<dataDir>/sessions.index.db`；表 `sessions_index(id TEXT PRIMARY KEY, title TEXT, updated_at TEXT, message_count INTEGER, mtime_ms INTEGER, size INTEGER)`
- WAL 模式；同步 API（better-sqlite3 本征同步，单用户无争用）

### Store 集成：`core/sessions.ts`

- `createSessionStore(dataDir)` 内部持一个 SessionIndex；构造时 **惰性 reconcile**（首次 list 前跑一次；用 stat 指纹比对，一致跳过，不一致重读该文件 upsert，孤儿行删）
- `list(opts?: {limit?: number; offset?: number})` → 走 SQL，返回 `{ sessions: SessionSummary[]; total: number }`；不带参数默认 limit=50, offset=0
- `create/save/append/setSummary/remove` 在既有逻辑后同步维护索引行（save 从 doc 取 title/updatedAt/messages.length + 写后 stat 指纹；remove 删行）
- 接口变更：`SessionStore.list` 签名与返回值如上——唯一调用方是 `GET /api/sessions` 路由与探针

### 路由：`server/routes/sessions.ts`

- `GET /api/sessions?limit=30&offset=0` → `{ sessions, total }`；limit 钳 1~200，offset 钳 ≥0
- `DELETE /api/sessions/:id` 增加边界：`runningSessions.has(sid) || streamBuffers.has(sid)` → 409「会话正在回答，先停止再删除」；通过后照旧 remove + sessionAllows 清理

### Web

- `api.ts`：`listSessions(limit?, offset?)` → `{ sessions, total }` 类型更新
- `useChat.ts`：
  - `sessions`、`hasMore`、`total` 状态；`refreshSessions()` 拉第一页；`loadMoreSessions()` 追加下一页
  - `deleteSession(id)`：调 DELETE → 成功后刷新列表；删的是当前打开会话 → `newChat()`；409 → toast 提示先停止
  - **深链修正**（分页后必须做）：`init()` 不再拿首页列表验证 wanted id——直接 `openSession(id)`，openSession 的 404 分支接手「toast + 回 /chat + 开最近会话」
- `SessionSidebar.vue`：每项 hover 浮出删除图标（EP Delete）；在跑会话（streamingSessions）删除图标禁用；底部 `total > 已加载数` 时显示「加载更多（n/total）」按钮

### 迁移

首次启动 reconcile 自然完成（扫目录建索引），无独立迁移脚本。索引文件可随时删除重建（指纹对账自动补齐）——索引是缓存不是事实源，事实源始终是 JSON 文件。

## 留给 builder 的裁量

- session-index.ts 的具体 SQL/接口形状微调；reconcile 放首次 list 还是构造时
- 侧栏删除按钮的交互细节（hover 浮现 vs 常显）
- 「加载更多」的文案与分页大小（30±）
