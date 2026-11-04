# personal-agent · 个人 Agent 工作台

三阶段（见仓库根 `PHASE3.md`）的宿主项目：能力长在真实日用场景上，不做孤立练习。

## 已有能力

### 对话（模块 14 · 常规 agent 界面）

一个输入框起步：文字、图片、文本附件一起发，SSE 流式出字。

- **模型可选**：下拉框数据来自 `GET /api/models`，目录由 `09-harness/llm.ts` 的四个档位生成
  （主 / 小 / 备用 / 视觉），同模型去重；换平台只改 `.env`
- **思考强度**：关 / 低 / 中 / 高，走统一翻译层 `thinkingParams()`——ARK 上只有开关真生效，
  支持分级的平台会同时收到 `reasoning_effort`（PITFALLS #37）
- **图片**：贴在输入框里随消息发送；**非视觉模型会前置 400**，不让用户对着上游报错猜。
  默认「图片仅最近一轮」——聊天 API 无状态，历史图每轮都重新计费（一张 1080p 截图 2~3k tokens），
  旧图自动换成文字占位，成本可控；取消勾选则原样保留
- **文本附件**：≤100KB 直接读入正文（PDF 暂不支持，提示先转图/文本）
- **完整 usage**：每条回复底部展示服务商原始 usage 的明细——prompt / completion / total /
  缓存命中 `cached_tokens` / 推理 `reasoning_tokens` / 耗时，不压成一个数
- **历史会话**：会话在服务端（`core/sessions.ts`），左侧栏列表直选（当前项高亮，刷新/重启后
  自动打开最近活跃的会话），顶部「＋ 新对话」开新账本
- **停止后继续**：流式过程中按钮变「停止」，点它 abort 上游并把已生成的部分落盘（标 `interrupted`），
  下一轮上下文接着用
- **上下文压缩**：超过 `PA_CONTEXT_BUDGET`（默认 6000 估算 token）时，旧轮交给 light 档模型摘要
  （关思考），`summary` + `summaryUntil` 落盘——之后每轮只发「摘要 + 截止点之后的原文」，
  不重复摘要、重启也有效；摘要失败或仍超预算则按整轮滑动窗口兜底，最新一轮永远保留。
  原文在账本里始终完整，界面历史不受影响
- **长期记忆**：回答完成后，后台把对话里关于用户的持久事实/偏好抽出来存进 `data/memories.json`
  （light 档、关思考），下一轮起以 system 前缀注入——**跨会话生效**。工具栏「记忆 N」可查看/单条删除，
  记错了能删；「清空」入口在 UI 里**禁用**（积累不易，防误触全清——真要清删 `data/memories.json`
  或调 `DELETE /api/memories`）。抽取输出过守门（非数组/对象元素/超长条目拒绝，已有记忆非空时
  拒绝清空式输出），失败只跳过本轮、记忆保持原样。`PA_MEMORY=0` 整体关闭（抽取+注入一起停）
- **知识库检索**：个人笔记（.txt/.md，≤1MB）上传后自动切块（约 500 字）索引，提问时本地
  BM25 检索（CJK 二元组分词），命中片段作为【知识库参考】注入本轮提问——零 API 成本、离线、
  确定性。只记「我记得我写过 xxx」的实体/关键词查询，这正是 BM25 主场（课程 07 对照实验结论）；
  语义改写召回以后加向量通道走 RRF 融合，`search()` 接口不变。寒暄级短查询（单 token）不检索；
  工具栏「知识库检索」可按轮关闭
- **语音输入**：按钮已占位，下一版接

服务端 `POST /api/chat`：客户端只发**新消息**（历史在服务端账本里），`stream:true` +
`stream_options.include_usage`；客户端断开即 abort 上游，防止没人看的长回答继续烧 token。

会话接口：

```text
GET    /api/sessions              列表（标题/更新时间/消息数）
GET    /api/sessions/:id          详情（消息 + 图片 URL）
DELETE /api/sessions/:id          删除
GET    /api/sessions/:id/images/* 会话图片（字节落盘，不塞 JSON）

GET    /api/memories              长期记忆列表
DELETE /api/memories/:id          删除一条记忆
DELETE /api/memories              清空

GET    /api/kb                    知识库文档列表
POST   /api/kb                    入库（name + text，切块索引）
DELETE /api/kb/:id                删除文档
```

### 产品核心（personal-agent/core/）

长期维护的部分放这里，课程模块保持「教学快照」不追改。目前：

- `core/config.ts`：数据根配置。`PA_DATA_DIR` 可改（相对 cwd 或绝对路径），
  缺省 `personal-agent/data/`（已 gitignore）
- `core/sessions.ts`：会话账本。一个会话 = `sessions/<id>.json` + 同名图片目录；
  原子写（tmp → rename）、id/文件名白名单防目录穿越；存储根由构造参数注入，不写死
- `core/context.ts`：上下文预算。token 粗估（中文 1 字/token、英文 4 字符/token、图片固定 1400/张）、
  按轮分组、摘要/保留切分、滑窗兜底、摘要调用；纯函数部分全部由探针覆盖
- `core/memories.ts`：长期记忆。抽取提示词/输出守门（课程 07 B 路线：回答完成钩子抽取，
  完整列表重放保 id）、`memories.json` 单文件原子存储；去重合并不做向量——抽取时把已有记忆
  整份喂给模型由它输出更新版，代码只守门
- `core/rag.ts`：知识库检索。CJK 二元组分词、按行切块（超长行硬切）、Okapi BM25 打分
  （零分过滤在源头）、`rag/kb.json` 单文件存储。`search()` 是唯一入口，向量通道以后在
  这里接（RRF 融合，07 已验证）

消息如何变成 API 形状（图片省略、失败消息排除）在 `chat.ts`；摘要/窗口的调度在 `server.ts`
的 `prepareContext()`——便宜的先做（省略图片），贵的后做（LLM 摘要），最后才是丢历史的滑窗。
记忆注入也在 `prepareContext()`（system 前缀，开窗时与摘要前缀一起保住）；抽取钩子在
`runMemoryExtraction()`（回答落盘后异步跑、串行化、自己消化异常——绝不弄崩对话）。

### 截图取字（模块 13 · 多模态第一件）

Win+Shift+S 截图 → 页面 Ctrl+V 粘贴 → 逐行文字 + 中文翻译，**点一行复制一行**、悬停看原文在图中位置。

- OCR：本地 tesseract（chi_sim 模型，含拉丁字母）——免费、离线、带逐行坐标
- 翻译：文本 LLM（非中文行才翻，中文原样保留；失败不阻塞 OCR）
- 语言包自愈：首次运行从 `node_modules/@tesseract.js-data/` 拷到 `.tessdata/`（gitignored）

### 两条识别引擎（模块 13 对照作业）

页面上「本地 / AI 识别」可切换（选择记在 localStorage）。两边输出同一 `OcrResult` 结构，
差异是结构性的，不是谁替代谁：

|             | 本地 tesseract              | AI 识别（视觉 LLM）                |
| ----------- | --------------------------- | ---------------------------------- |
| 字符准确    | 清晰截图很稳                | 可能编字/漏行                      |
| 版式理解    | 弱（按行切）                | 强（能合并断行、忽略页眉）         |
| 坐标/置信度 | 有（=点行定位、低置信提示） | **无**——LLM 报坐标幻觉严重，不伪造 |
| 成本/离线   | 免费离线                    | 按图计费、依赖配额                 |

AI 引擎配置（缺省沿用备用档 = GLM 视觉，模型默认 `glm-4.5v`）：

```bash
LLM_VISION_BASE_URL=...   # 缺省 LLM_BACKUP_BASE_URL → LLM_BASE_URL
LLM_VISION_MODEL=glm-4.5v
LLM_VISION_API_KEY=...    # 缺省 LLM_BACKUP_API_KEY → LLM_API_KEY
```

AI 失败（配额/网络/输出不合规重试后）返回 502，UI 提示切回本地——AI 挂不拖累本地路线。

### 前端（Vue 3 + Vite）

源码在 `personal-agent/web/`，按职责拆开——网络形状只改 `api.ts`，状态与流程在 `composables/`，
组件只负责渲染：

```text
web/
├── index.html
├── vite.config.ts          # 开发端口 5173 + /api 代理到 8798；构建输出到 ../public
└── src/
    ├── main.ts / App.vue / styles.css
    ├── types.ts            # 与 Node 服务端对齐的数据形状
    ├── api.ts              # 所有 fetch / SSE 解析都在这里
    ├── composables/        # useChat（对话状态 + 流式）、useOcr（识别状态）、useMemories / useKb
    ├── components/
    │   ├── common/         # AppHeader / ToastHost / MarkdownView / UsageMeta
    │   ├── chat/           # ChatPane / SessionSidebar（历史会话列表）/ ChatToolbar / MessageList /
    │   │                   # MessageItem / ChatComposer / AttachmentChip / MemoryPanel / KbPanel
    │   └── ocr/            # OcrPane / OcrDropZone / OcrToolbar / OcrLineList / OcrLineItem
    └── utils/              # markdown / usage / clipboard / toast
```

```bash
npm run pa:web                    # 开发：Vite 5173（热更新，另开 8798 的 Node 服务）
npm run pa:build                  # 构建到 personal-agent/public（server 直接托管）
npm run pa:check                  # 前端 .ts 类型检查

node personal-agent/server.ts     # → http://127.0.0.1:8798（对话 + 截图取字两个标签页）
node personal-agent/probe.ts      # 零 token 探针（OCR / 消息构建 / 会话存储）
```

`personal-agent/public/` 是构建产物（文件名固定，便于 git diff），不要手改；改 UI 请改 `web/src/`。

运行数据默认在 `personal-agent/data/`（gitignored）；要换位置：

```bash
PA_DATA_DIR=D:/pa-data node personal-agent/server.ts
```

环境变量：`PA_PORT`（默认 8798）、`PA_HOST`（默认 127.0.0.1，只本机）、
`PA_DATA_DIR`（默认 `personal-agent/data`）、`PA_CONTEXT_BUDGET`（默认 6000 估算 token）、
`PA_MEMORY`（`0` 关闭长期记忆）。

> `PA_HOST=0.0.0.0` 会把**全部会话内容和图片**暴露给局域网，且目前没有鉴权——只在可信网络临时用。

> 选型记录：视觉 LLM（火山 Coding Plan / GLM）2026-11-03 实测均不可用或撞配额；
> 且 OCR 是确定性任务，本地引擎比 LLM 更准更省——LLM 只做它擅长的翻译。
