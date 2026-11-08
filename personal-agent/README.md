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
- **工具调用（agent loop）**：模型可以「做事」不只「说话」——流式工具循环（`core/agent.ts`）：
  每轮流式出字，模型要工具时累积 `tool_call` 分片 → 执行 → 结果喂回 → 下一轮，直到出文本答案。
  只读工具（自动放行）：`get_time`（今天/现在类问题的锚点，模型对当前时间永远无知）、
  `search_kb`（模型自主检索知识库——比固定注入强在可换关键词多查几次、要不要查由模型判断；
  工具开启时自动注入让位，同一内容不双份进上下文；寒暄闸对工具路径关闭，单关键词精确查询
  不被误伤）、`browser_read`（无头浏览器读网页，见下）、`browser_inspect`（页面体检：截图 +
  视觉描述 + 控制台，见下）。写入工具（确认门批准才跑）：
  `remember`（记事实进长期记忆，07 A 路线）、`forget`（按原文精确删一条记忆，改写过的文本删不掉）、
  `add_note`（存笔记进知识库，search_kb 的写侧对偶）——参数原文整张卡亮给人看，批了才落账。工具轮上限 5，超限后最后
  一轮去掉 `tools` 强制出文本答案；每次调用以 🔧 芯片展示在回答上方，点开看参数/结果/耗时，
  trace 随会话账本落盘。工具执行错误（未注册/参数非 JSON/实现抛错）变成喂给模型的字符串，
  不崩循环。**同轮多调用的执行策略**：只读工具并发跑（墙钟取 max 不取 sum）；写入工具严格
  串行过门、确认卡一张一张出——后面的决定能看到前面的结果，「本会话总是允许」也靠顺序
  生效（批第一个时勾了，同工具的后续调用自动放行）；喂回模型的 tool 消息一律按
  `tool_calls` 原序拼（并发完成序会乱，API 契约要求原序对应）。工具栏「工具调用」可按轮
  关闭（关掉后知识库检索自动回到注入模式）
- **浏览器工具（模块 14 computer use，读 + 操作 + 体检）**：`browser_read(url?)`——服务端
  Playwright 无头 Chromium 打开网页，等 JS 渲染完取正文（`domcontentloaded` + 网络静默竞速 +
  小憩，SPA 也读得到），返回标题/最终地址/正文（超 6000 字截断标注）+ **可操作元素索引**：
  快照时给页面上可见的链接/按钮/输入框打 `data-pa-ref` 编号，`[3] button「登录」` 一行一个
  （≤80 个）。`browser_click(ref)` / `browser_type(ref, text, submit?)` 按编号操作——**写侧，
  过确认门**，且卡面不是 `{"ref":3}` 而是解析后的「点击网页元素 [3] button「登录」」
  （`ToolDef.describe` 把参数翻译成人话；解析不出就明说）。选择器注入式路线：模型读索引 →
  决定点/填 → 过门 → 不带 url 再 `browser_read` 读当前页验证——read→act→read 闭环。
  页面一变编号作废（报错人话化让模型重读，不猜）；`browser_read` 不带 url = 读当前页
  （不重新导航）。多个浏览器操作并发进来时在执行器里互斥排队（一个标签页同时只够一个
  导航——墙钟是 sum，浏览器的物理约束），喂回仍按原序。URL 守门只放 http/https
  （`file://` 读本机文件、`javascript:`/`data:` 注入面一律拒）；打不开错误也变工具结果，
  循环不崩。Chromium 惰性拉起（首次调用才起）、关服时进程树收掉；`PA_BROWSER=0` 整组
  浏览器工具不注册。真机实测：glm-5.3 自主 read→click→read 切换标签页并准确描述新页内容
  （操作 426ms，卡面正确解析元素）
- **页面体检（browser_inspect，开发调试）**：截图 + 控制台两半。截图存盘
  （`data/browser-shots/`，封顶 20 张自然淘汰），报告里以 markdown 图给出——**前端渲染器
  只放行自家 `/api/` 路径的图**，外链/data: 一律不当图；同时由视觉档（glm-4.5v）生成文字
  描述喂回主模型（感知/推理分工，与截图取字同构——主档不吃图，也不依赖「工具消息带图」
  这种未探测的 API 能力；视觉挂了就降级，控制台照常）。控制台是确定性半边：自本次加载起
  的 pageerror / console.error / 请求失败（`net::ERR_*`）/ HTTP 4xx5xx 全量捕获（错误类
  上限 30 条），log/info 只报数量与最近两条；导航即重置（和真实 devtools 的口径一致）。
  视口钉死 1280×800，只截当前视口不整页。真机实测：体检自家页面，视觉描述布局准确、
  控制台干净判断正确，单次 ~3k tokens（视觉子调用 ~1.5k）
- **写入确认门**：`risk:'write'` 的工具执行前在流里发确认卡（⚠️ + 工具名 + 参数原文），
  人点「允许」才真跑，「拒绝」把理由喂回模型让它改口；超时（`PA_CONFIRM_TIMEOUT_MS`，默认
  120s）/断流一律按拒绝收尾，门永不无门放行（没接门也拒绝，fail closed）。被拒的调用同样
  留 trace——审计线上「问过但没批」也是事实。卡上可勾**本会话内总是允许**：勾后该工具在
  本会话不再出卡直接执行（芯片照常留痕）——授权只存服务端内存，重启即清、不跨会话，长期
  授权是危险品，刻意不给它落盘
- **语音输入（双引擎，工具栏切换）**：麦克风录音转文字进输入框，两条路线对照——
  - **浏览器引擎**（默认，Chrome/Edge）：Web Speech API 边说边出字（未定段随说随显、定稿定格），
    停止后可编辑再发送。零成本零后端，但不支持的浏览器（Firefox）没有此能力
  - **大模型引擎**（`POST /api/asr`，任何浏览器可用）：Web Audio 采 PCM → 浏览器手写 PCM16 WAV
    （`web/src/utils/wav.ts`，纯函数探针钉死）→ 上传后端 → OpenAI 兼容
    `/audio/transcriptions`（GLM-ASR，`PA_ASR_*` 三件套可整体换平台，缺省回落
    备用/小档/embed 档的按量端点）→ 文本说完 1~2s 一次进草稿。按时长计费（分/分钟级）。
    不用 MediaRecorder 直传是踩过坑的：Chrome 只产 webm/opus，GLM-ASR 端点 400
    「不支持当前文件格式」——「OpenAI 兼容」指协议不指文件格式，wav 才是转写端点的最大公约数
  - 两引擎同一拼接语义（已有草稿则另起一行）；不支持的浏览器自动落大模型引擎、选项置灰；
    两头都没配时 🎤 一并隐藏。流式 ASR（WebSocket 边说边出字）与原生语音多模态（音频直接
    进模型）是后续层——接口形态完全不同（WS 状态机/多模态 content）
  - 纯逻辑层（`web/src/utils/voice.ts` + `asr.ts`）探针覆盖：DOM 结果形状/错误码人话、
    配置回落矩阵/音频校验（mime 白名单、25MB 上限）/响应解析
- **MCP server（模块 15 · 能力外露给 Claude Code）**：`node personal-agent/mcp-server.ts`
  或全局命令 `pa-mcp`（`npm link` 后任何目录/任何 MCP 客户端可用）——手写 stdio JSON-RPC
  （换行分帧，不引 SDK），工具面 = **读三件** `kb_search`/`browser_read`/`browser_inspect`
  （inspect 截图直接以 image 内容块返回，感知交给客户端模型，与工作台内「视觉档子调用」
  是同能力两分工）+ **写五件** `remember`/`forget`/`add_note`/`browser_click`/`browser_type`
  （与工作台产品核心同一写入路径；审批语义在客户端——Claude Code 对写操作逐个请求批准，
  与工作台内「确认卡」是同一原则的两处落地）。协议形状照 2025-06-18 规范：initialize
  版本协商、错误两层（协议错 -32602 vs 执行错 `isError` 结果）。`PA_MCP_READONLY=1` =
  写面全撤只留三读（kill switch）；`PA_BROWSER=0` = 浏览器工具全撤。复用 `core/rag`/
  `core/memories`/`browser`，不 import `server/state`；数据目录与工作台共享（缺省同一
  `data/`，`PA_DATA_DIR` 可改）。仓库根 `.mcp.json` 已注册；建议在 `.claude/settings.json`
  把读三件放进 `permissions.allow`（自动放行），写五件**不列**（默认每次询问）——想强制
  兜底可把写五件放进 `permissions.ask`。关停走 stdio 语义：客户端关 stdin = 先排干在途
  应答（one-shot 管道调试不截断异步响应）再收浏览器进程树退出
- **技能（模块 15 · 把真实流程沉淀成可复用资产）**：`personal-agent/skills/` 下 SKILL.md
  格式的技能文档（frontmatter `name`+`description` + 正文步骤），机制与 Claude Code 的 skill
  同构——系统提示只注入**索引**（name + 触发条件，供发现），agent 判断用户需求匹配某技能时
  调 `use_skill(name)` 加载**全文**再严格照步骤执行（发现与执行分离）。技能两种形态：
  **单文件 `skills/<name>.md`**，或**文件夹 `skills/<name>/SKILL.md`**（同目录可放模板/参考文档
  等支撑文件，正文里用 `read_file` 按需读；技能名必须 = 文件/目录名，重名/不一致 = 抛错）。
  核心设计纪律：索引的 description 只写触发条件、**绝不概括流程**（描述概括了流程 agent 会走
  捷径跳过正文——这是 skill 发现性设计里被实测验证的一条）。技能正文用 agent 现有的工具
  （get_time/search_kb/add_note…）描述步骤。`PA_SKILLS_DIR` 可改技能目录；目录不存在 = 无技能
  （不炸）。前端有「技能」面板（`GET /api/skills` 列可用技能 name+description），对话里加载
  某技能时消息区显示「🧠 加载技能「名字」」chip、点开可看加载全文。技能 frontmatter 可带
  `triggers`（逗号分隔触发词）——用户消息命中任一词时工作台**自动把技能正文注入上下文**，不依赖
  模型主动调 use_skill（实测 deepseek 常跳过加载凭记忆自由发挥，自动加载是可靠兜底）。首个技能是 `weekly-summary`
  （近期知识库总结：get_time 锚定日期 → 多词多次 search_kb → 分节汇总，诚实边界=检索结果不带
  日期不假装精确到周）。真机实测：问「总结我这周学了什么」→ use_skill → get_time → search_kb
  ×11 → 分节总结，全程 4 轮。第二个技能 `learning-review`（文件夹形态：SKILL.md +
  支撑文件 questions-guide.md）——把每日复盘仪式移植进工作台：get_time 定日期 → git_log 拿当天
  提交 + search_kb 找相关笔记 → write_file 写 `reviews/<日期>.md`（四节：今天学了啥/核心知识讲解/
  两类面试题/参考答案）→ add_note 镜像进知识库；「昨天」变体加第 5 节复习题。触发条件照旧：「复盘/
  写日报/总结今天学了啥/回顾昨天」
- **仓库能力（模块 15 · git + 文件工具）**：`git_log`（只读——查最近提交，`since`/`until`
  时间窗 + `max` 条数，返回「提交号 日期 消息」；**圈定单日必须 since=该日 + until=该日的次日**，
  否则混入其后几天的提交——11.3 复盘实测踩出的截断坑）、`read_file`（只读——读仓库内文件，超长截断）、
  `write_file`（**写侧，过确认门**——写白名单目录内文件）。安全模型：路径一律**仓库相对**、
  拒绝穿越/绝对路径；读挡 `.env` 与工作台自己的 dataDir（`PA_DATA_DIR` 若在仓库内自动加入
  黑名单）；写只放行白名单目录（`PA_WRITABLE_DIRS` 逗号分隔可改，缺省 `reviews` +
  `personal-agent/skills`）。仓库根 `PA_REPO_DIR` 可改（缺省 cwd）。git 用 `execFile` 参数数组
  调用（不经 shell，`since` 无注入面）。执行器在 `repo.ts`（与 browser.ts 同构，tools.ts 只接线）。
  这三个工具是复盘类技能（git log + 写 reviews/）移植到工作台的先决条件。真机实测：查最近 3 次
  提交 / 读复盘文件 / 写临时文件（确认门批准）全通过

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

POST   /api/chat/confirm          应答写入工具确认卡（confirmId + approve）
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
  完整列表重放保 id）、`memories.json` 单文件原子存储 + **读写串行链**（`mutate()` 事务：
  抽取钩子与 remember 工具共用同一文件，先 list 后 save 的窗口里不丢更新）；去重合并不做
  向量——抽取时把已有记忆整份喂给模型由它输出更新版，代码只守门。A 路线（模型自主
  remember 工具）已接入，写入走确认门
- `core/rag.ts`：知识库检索。CJK 二元组分词、按行切块（超长行硬切）、Okapi BM25 打分
  （零分过滤在源头）、`rag/kb.json` 单文件存储。`search()` 是唯一入口，向量通道以后在
  这里接（RRF 融合，07 已验证）
- `core/agent.ts`：流式工具循环。课程 09 harness 的纪律全部保留——dispatch 是所有工具
  调用的唯一咽喉（永不抛、错误喂模型）、空工具面省略 `tools` 字段（PITFALLS #25）、
  步数上限后强制文本收尾、结果在源头截断、abort 是状态不是异常（#38）。写入工具走
  `onConfirm` 确认门：没接门/门抛错/拒绝一律不放行（fail closed），拒绝也是一次已应答的
  工具调用（理由喂回模型）；工具清单在 `tools.ts`（core 不认识具体工具）
- `core/skills.ts`：技能注册表（模块 15）。`skills/` 目录技能文档的读写与解析（单文件
  `<name>.md` 与文件夹 `<name>/SKILL.md` 两种形态都收；非技能命名 md / 无 SKILL.md 的目录跳过；
  重名、frontmatter name 与文件/目录名不一致 = 抛错）——`parseSkillDoc`（frontmatter 剥
  name/description，缺必填抛错不许静默吞）、`index()`（发现用：只给触发条件）、`load(name)`
  （执行用：返回全文；非法名防路径穿越直接 null）、`renderSkillIndex`（系统提示注入块，超长
  描述截断）。不依赖 LLM/HTTP，纯 IO + 解析

消息如何变成 API 形状（图片省略、失败消息排除）在 `chat.ts`；摘要/窗口的调度在 `server/chat-service.ts`
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

### 后端（Koa）

源码在 `personal-agent/server/`（`server.ts` 是指向它的薄入口，保留 `node personal-agent/server.ts`
的历史跑法）。按职责拆开——HTTP 形状只改 `routes/`，对话域逻辑不带 HTTP 概念：

```text
server/
├── index.ts        # 入口：组装 + 监听 + 信号收尾（tesseract worker）
├── app.ts          # Koa 应用工厂：错误映射 / 静态托管（public/，防目录穿越）→ 路由挂载 → 404 兜底
├── state.ts        # 进程级单例（store/memories/kb/tools/ASR）+ 确认门状态 + 记忆抽取串行链
├── http.ts         # JSON 应答 / 请求体读取（25MB 上限）/ dataURL 解码
├── chat-service.ts # 对话域服务：会话详情视图 / 上下文预算调度（摘要+滑窗）/ 知识库注入
└── routes/         # chat（SSE + 确认门）/ sessions / memories / kb / models / asr / ocr
```

SSE 的 Koa 姿势：`ctx.respond = false` 接管原生 res 直写帧（断开 abort、半截落盘、确认门随流
收尾的流控语义原样保留）；`respond = false` 只在开流前一刻设置——之前的校验失败仍走 Koa 的
JSON 错误路径，不会被吞。

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
`PA_MEMORY`（`0` 关闭长期记忆）、`PA_BROWSER`（`0` 不注册 browser_read 浏览器工具）。

> `PA_HOST=0.0.0.0` 会把**全部会话内容和图片**暴露给局域网，且目前没有鉴权——只在可信网络临时用。

> 选型记录：视觉 LLM（火山 Coding Plan / GLM）2026-11-03 实测均不可用或撞配额；
> 且 OCR 是确定性任务，本地引擎比 LLM 更准更省——LLM 只做它擅长的翻译。
