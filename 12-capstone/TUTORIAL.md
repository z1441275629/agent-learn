# 模块 12 · 框架横评 + 毕业项目（二阶段收官）

> 定位：此刻学框架不再是「抄别人的用法」，而是**识别它帮你封装了什么**——你手写过 06~11 的每一层，
> 框架在你眼里应该是透明的：每个抽象背后都是你踩过的某个坑。
> 收官三件：横评三个框架（重写你写过的东西）、一张「手写 X = 框架 Y」对照表、
> 毕业项目（四件套全用 + 前端交付 + 真实用户用一周）。

## 0. 横评的方法论

- 识别封装的三问：它替你管了什么（循环？消息滚动？状态？重试？）、它**没**管什么（成本护栏？evals？注入防御？）、它管的部分你手写时踩过什么坑
- 每个框架的验法都一样：**拿你写过的模块重写一遍**——不是新写 demo，是同一任务两个实现对照（mini_agent / planner-executor / harness）
- 表达点：「我先用 X 行手写了它，再看了它的源码/文档」——这句话比「我用过 X 框架」值钱一个量级

## 1. Vercel AI SDK：TS 原生轻量——重写 mini_agent

- **任务**：模块 3 的 mini_agent 同款任务（查天气 → 下雨才买伞 → 算总价），用 `generateText` + `tool()` 重写
- 对照点：
  - 你手写的 while 循环 + tool_calls 解包 = SDK 的什么？（maxSteps / tool-choice / 消息滚动谁管）
  - JSON Schema 手写 vs `tool({ description, inputSchema })` 声明式
  - `onStepFinish` —— 你在模块 3 里手打的 `[step N]` 日志，框架给的钩子长什么样
  - token 账：SDK 的 usage 结构 vs 你手记的 SpawnResult 双栏
- 引导问题：SDK 的循环和你的 while 有本质区别吗？`stopWhen`/`maxSteps` 防死循环对应你哪行代码？
- **streaming**：`streamText` 变体——SSE 的产出形态（§7 前端交付的地基）
- 数据槽：两版各跑同任务的 token 双栏 / 步数 / 耗时：手写 315+445+532+545=1837/111+77+38+123=349，SDK 1173/372(generateText) 1159/191(streamText)

### 实做记录（2026-10-26）

一发全通（[ai-sdk-agent.ts](ai-sdk-agent.ts)，同任务同模型同端点跑两版）：

- **SDK 版**：generateText 3 步（weather 357/99 → calculate 395/64 → 终答 442/79），全账 1194/242、19.9s；streamText 首字 5339ms、全账 1200/283、19.6s
- **手写版**（模块 3 同任务复跑）：step 1 一发**并行**报出两个工具（weather+calculate 同轮），1 步收干净。注意：工具并行/串行是模型随机行为不是框架差异——防误读

对照发现（按含金量排）：

1. **手写版根本不记账**——模块 3 的 usage 就躺在 response 里没取，SDK 版每步双栏 + 汇总白送（`onStepFinish`/`result.usage`）。观测是刻意设计出来的，框架默认给——「封装了什么」的反面是「手写时你根本没想到要什么」
2. **五件套逐一对应**：while 循环+步数保险 = `stopWhen: stepCountIs(8)`；手拼 JSON Schema = `inputSchema: z.object()`（类型即 schema，一处维护）；dispatch 查表+parse+try = `execute`（SDK 管查表/解析/异常反馈）；手打 `[step N]` 日志 = `onStepFinish`；消息滚动 = 被封装吞掉（想看 messages 要开 include——模块 3 你亲眼看数组滚动的教学价值，SDK 用透明度换便利）
3. **框架 API 也在漂移**：v5→v7 usage 字段改名 `promptTokens`→`inputTokens`——升级框架和升级模型一样要跑探针，不是免费的
4. **`.chat()` vs `.responses()` 双出口**：@ai-sdk/openai 能出两套协议的模型，responses 是 OpenAI 专有（GLM 不兼容），OpenAI 兼容端点必须选 chat——选错才发现不了，tsc 不查协议
5. **streamText 白送中间过渡句**（「我先查一下天气」）——generateText 只有终稿；流式形态多给了「模型在想什么」，§7 前端可视化的原始素材就是它
6. **附带发现：老模块 env 换代哑火**——01~03 读 `GLM_API_KEY`，.env 已全仓切 `LLM_*`，本次靠临时透传才跑起来。历史 demo 的维护债实录（新代码直接对齐 `LLM_*` 统一入口）
- 代码量：手写 mini_agent 148 行 vs SDK 侧重写 ≈40 行（工具定义 20 + 调用 20）——省的是循环和消息管理，**没省的是 system prompt、任务设计、假工具的演示路径设计**

## 2. LangGraph.js：状态机 + 持久化——重写 planner-executor

- **任务**：模块 8 的 planner-executor（计划 → 逐项执行 → 异常 replan）用 StateGraph 重写
- 对照点：
  - 图的节点/边 = 你手写的什么？（planner / executor / replan 判断三个函数 → 三个节点？）
  - **checkpointer** = 你模块 09 的会话存档 resume——框架管了序列化/恢复，你手写时踩了什么
  - 状态对象（State channels）vs 你手写的共享 messages 数组——reducer 归并语义
  - 条件边（conditional edges）vs 你的 if 重规划
- 引导问题：LangGraph 的「图」比 if-else 循环好在哪？什么规模以下它纯属负担？
- 数据槽：同任务两版成功率/结构对照：手写 ____，LangGraph ____

### 实做记录（2026-10-27）

[langgraph-planner.ts](langgraph-planner.ts)：StateGraph 四节点（makePlan / executeSteps / replanNode / finish）+ 条件边路由，重写模块 8 的调度层。探针 9/9（P1 全 done + 依赖顺序 / P2 失败→重试耗尽→replan 保 done / P3 replan 熔断 / P4 interrupt 中断 + Command 恢复，全零 token 假 LLM）+ 真链冒烟一发全通（GLM 出 3 步计划 8.6s，interrupt 人工门触发 → `yes` 恢复 → 全 done，报告成型）。

对照发现：

1. **图 channel 没人首赋值 = undefined 参与路由（PITFALLS #34）**：`replans: Annotation<number>()` 无 default，makePlan 只返回 plan/log——路由里 `undefined < MAX_REPLANS` 恒 false，**replan 分支永远不会走**，类型系统还说它是 number（tsc 逮不住）。手写版 `let replans = 0` 的语法强制，图形态降级成约定。修法 = 首节点补齐全量字段。这次是探针逮的：异常路由探针（replan/熔断）在，静默走错分支就现形
2. **reducer 不是必需品**：plan/stepResults/replans 全用默认覆盖语义（LastValue）——恰好就是手写版 `plan = await replan(...)` 的赋值语义。唯一自定义 reducer 是 log（appendOnly），价值在多节点并发追加不丢——手写版靠单线程顺序天然安全，图形态并发了才需要显式归并
3. **不可变状态语义**：节点里改 plan 要先 `structuredClone`（返回新引用）；手写版直接改闭包对象。图逼你回答「谁拥有状态」——手写版答案靠纪律（executePlan 独占 stepResults），图形态答案靠机制
4. **interrupt()/Command({resume}) = 模块 09 confirm 的框架版**：一次调用暂停整图、checkpointer 自动存快照、恢复用 Command——手写版要自己设计「暂停点存档+恢复协议」；getState 白送断点检查（`next=["executeSteps"]`）。真链 8.6s 出图即停、恢复续跑，中间态零丢失
5. **框架管「状态怎么流」，不管「业务对不对」**：zod 校验+自修一轮、步间交接文本、重试打勾、「保 done 不重跑」——模块 8 的业务逻辑全部原样搬运，一行没省。省的只是 while 循环骨架和落盘存档（saveCheckpoint 20 行 → checkpointer 一个参数）
6. **探针断言又错一次**（P2 重试计数没算 replan 后替换步骤的合法第 4 次调用）——「探针挂先查断言再查实现」第二次兑现（第一次见模块 11 §7）
7. ChatOpenAI 直连 GLM 零障碍（`configuration.baseURL`）——和 Vercel AI SDK 的 `.chat()` 同一课：OpenAI 兼容端点是事实标准，框架层选型不受厂商锁定
- 代码量：手写 317 行 vs 图版 ~230 行（其中探针 100 行）——纯业务对照约 317 vs 130。省的是骨架，不省的是脑子该想的事

### 增补：Send fan-out 并行版（2026-10-27，用户 review 逮出）

首版 executeSteps 把整批 runnable 关在**一个节点里 for 串行**——手写版默认 `PARALLEL=Promise.all` 的行为差异没声明。比「节点内补 Promise.all」更对的是图形态的正统并行：**dispatch 条件边 `Send` fan-out 到 executeOne，并行升进图拓扑**。探针 9/9 → 11/11（新增 P1b 真并发断言 inFlight 峰值=3、P5 并发写拦截），真链冒烟全通（GLM 出依赖链计划、逐批推进全 done）。

三个新对照发现：

1. **状态被迫分离**：`status/retries` 原来塞在 `plan.steps` 里（手写版「一个对象走天下」，落盘方便）——并发节点各写各的步骤状态，必须拆出 `stepStatus` channel（merge reducer 按 key 归并）。静态计划与动态执行态分离不是洁癖，是**并发的物理前提**
2. **框架把隐性竞态变成显式报错（P5 实证）**：无 reducer 的 LastValue channel 被并发写 → `InvalidUpdateError: "LastValue can only receive one value per step"`。模块 8 金笔记②「Promise.all 并发写同名文件互相覆盖」是静默出错，LangGraph 直接拒绝执行——**归并语义从「祈祷没错」变成「必须声明」**。`stepResults` channel 也因此从覆盖语义升 merge
3. **recursionLimit 是图形态的隐性税（PITFALLS #35）**：P3 熔断探针当场 `GraphRecursionError`——图形态把重试/replan 摊进拓扑，**每趟 dispatch/executeOne 都计一步递归**，默认上限 25 按节点执行数计；熔断路径（3 重试 × 3 replan × dispatch+executeOne 交替）≈26 次节点执行刚好爆表。手写版 while 循环没有这种税——图越细粒度，递归预算越要是显式参数
4. **附带 n=1 复课**：首版冒烟过了、重构版冒烟当场炸在 ```json 围栏——「简版」省掉模块 8 的围栏剥除保险，上一发没围栏纯属运气（模块 11 §8 n=1 方差边界同课）。修法：花括号切片（比剥 fence 鲁棒——围栏/寒暄/尾随句全剥）

## 3. Claude Agent SDK：产品级循环——和你的 09 harness 对照

- **任务**：读它的 agent 循环 + 权限 + hooks 结构（你每天在用的 ZCode 的近亲），对照模块 09 手写的壳
- 先验证：GLM 的 anthropic 兼容端点能不能喂它跑真任务；不行就纯阅读级（读结构、跑不起就不烧）
- 对照点：权限系统（你的 allowlist+confirm）、hooks（你的前后拦截器）、MCP 接入（你的模块 4）、Skills（你的模块 5）
- 引导问题：产品级 SDK 在你手写版之上多花了多少代码在「敢给别人用」上？
- 数据槽：能跑则记一次运行的账 ____/____；不能跑则记「兼容性卡点：____」

### 实做记录（2026-10-27）

**端点验证先行**：GLM 的 anthropic 兼容端点（`open.bigmodel.cn/api/anthropic`）最小请求 HTTP 200——glm-5.3 走 anthropic 协议连 thinking 块都带，SDK 可真跑（不降级阅读级）。SDK 版 @anthropic-ai/claude-agent-sdk 0.3.311。

[claude-agent-demo.ts](claude-agent-demo.ts)：一条任务链看全三层——Bash(ls) 列目录 → Read 素材 → Write 建文件（过 confirm）→ record 落台账（MCP 自定义工具）。**三版迭代才跑通**，每版暴露一层产品级默认行为（全部落 PITFALLS #36）：

| 版本 | 症状 | 根因 |
|---|---|---|
| v1 | 106s/7turns 全烧在 ToolSearch 上，GLM 三轮搜索全空、诚实汇报「工具不存在」 | 工具默认 **defer 到 ToolSearch 后**（对官方模型省 prompt token 的优化）；修：`tools` 显式列出 + MCP server `alwaysLoad: true` |
| v2 | Bash/Write 全静默执行，canUseTool 一次不响 | permissionMode 不显式时 Write 疑似被 acceptEdits 类默认放行；修：显式 `permissionMode: 'default'` |
| v3 | record 连拒 3 次 → maxTurns 8 熔断 | 权限层收到的工具名是**全名** `mcp__demo-tools__record`，回调里匹配短名永远不中；修：全名匹配 + maxTurns 留出 deny-重试预算 |

**v3 全链通过**：confirm 触发 2 次（Write 同意、record 同意）、放行副作用 done.txt 真写入沙箱、MCP 台账落账、6 turns / 4678/1222 / 42.3s / success。跑完自动清场（可重复跑）。

对照发现：

1. **自定义工具体就是 MCP**——`createSdkMcpServer({tools:[tool(...)]})` 一行 = 模块 4 手写的 McpServer + 模块 09 registry 的合体；zod shape 即 schema（§1 Vercel AI SDK 同款收敛）
2. **CLI 内置命令分级**：Bash(ls) 这类只读命令走默认安全规则直接放行，canUseTool 不响——模块 09 手写的 allowlist 之上，产品级 harness 还有一层「命令安全分级」
3. **cwd 是工作目录不是沙箱**（最扎的一条）：`cwd=sdk-sandbox` 下 agent 被 deny 后拿 Glob/Read **读到了仓库根的 PITFALLS.md**（还自动按仓库惯例准备记坑）——白名单工具没有路径边界。对照模块 09 手写的路径检查：**硬边界要自己造（路径检查/OS 级容器），框架的 cwd 只是默认落脚点**
4. **产品级 harness 白送的**：权限分级/审批回调/工作目录/分块消息流/usage 记账/步数保险——对照模块 09 一件件手写的清单，SDK 一个 options 对象收走
5. **deny-重试烧 turns**：被拒的模型会换着法子重试（短名/全名/换工具），每次都是一轮——maxTurns 预算要含失败路径（与 #35 递归预算同族：产线每种资源都有上限）
6. **协议兼容 ≠ 行为兼容**（PITFALLS #36 总纲）：anthropic 协议通了只保证 API 200，产品默认行为（工具发现/权限默认/边界语义）全是官方假设——冒烟按「任务全链完成」验收，不按「API 返回 200」

## 4. Python 阅读级：LangGraph / OpenAI Agents SDK / CrewAI 概念对照

- 不动手，读概念：三者的 agent 抽象各是什么形状（图 / runner / 角色编排）
- 你能读懂它文档里每个概念的 TS 对应物——这就是「Python 阅读力」的验收
- 数据槽：三个框架各一句「它的 X = 我手写的 Y」：____ / ____ / ____

### 实做记录（2026-10-27）

三份官方文档通读（docs.langchain.com LangGraph Python overview / openai.github.io/openai-agents-python / docs.crewai.com agents+crews 概念页），零 LLM 配额。验收自答：**三家概念表逐条能映射回手写件或 §1~3 实做的 TS 框架，无一个生词**——Python 阅读力达成。

对照发现：

1. **控制流归谁是三家的分水岭**：LangGraph 你画图它管状态流（orchestration runtime）、OpenAI Agents SDK 它管循环你填 Agent（runtime 白送 turns/工具执行/交接）、CrewAI 它管流程你填角色（连执行顺序都不用你操心，Process 一句话）。抽象高度递增、可干预度递减——和「手写 while → 图 → 产品 harness」的自由度梯度同构
2. **LangGraph 官方自己给了横评的分层背书**：文档明说自家生态 = framework（LangChain，agent 抽象）/ runtime（LangGraph，编排）/ harness（Deep Agents，产品化组装）——§1~3 三个 TS 框架恰好各占一层（Vercel AI SDK≈调用层库、LangGraph=runtime、Claude Agent SDK=harness）。Deep Agents（planning+subagents+文件系统+上下文管理打包）就是模块 06/08/10 的产品化合体形状
3. **Python↔JS 的差异主体是声明语法不是概念**：LangGraph Python 状态用 `TypedDict` + `Annotated[list, add_messages]`（reducer 挂在类型注解里）= §2 JS `Annotation.Root({...})`（函数调用式声明）——同一套 channel/reducer 语义换载体。StateGraph/条件边/Command/Send/interrupt/checkpointer 全部同名同义（JS 版本就是从 Python 移植的）。Python 版自述受 Pregel/Apache Beam 启发——§2 实测的 superstep 并行语义有出处
4. **OpenAI Agents SDK 的 handoffs = 模块 10 spawn 的官方形状**：Agent 定义里声明「可以交接给谁」，循环中 LLM 主动触发——和我手写的委派（把子 agent 当工具调）机制相同，差别在它是 SDK 一等公民（类型/追踪/校验都认它）。Guardrails（输入/输出校验，与主调用并行跑、fail fast）= 模块 08 zod 校验+自修的运行时前移版；Sessions = 模块 07 记忆/09 会话恢复；内建 tracing = 模块 11 TraceCollector 的平台版。文档原话「只用 Responses API 自己管循环，还是 SDK 替你管」——§1 那句「手写 while = stopWhen」的官方口径版
5. **CrewAI 把我手写的三件套摊平成配置项**：`planning=True`（AgentPlanner 执行前给每个 Task 预计划）= 模块 08 planner-executor；`respect_context_window`（超窗自动摘要）= 模块 06 ContextManager；hierarchical Process（manager_llm 协调/委派/验证）= 模块 10 composite 的管理者模式。Agent(role/goal/backstory)+Task(description/expected_output) 的角色范式 = 我的 researcher/writer/critic 人格从「函数+prompt」变「配置对象」；`crewai replay -t <task_id>` = 模块 08「保 done 不重跑」+ 09 resume 的合体
6. **三家殊途同归的收束点**（每一层坑的收敛证据）：步数上限家家有（maxTurns / max_iter 默认 20 / recursionLimit 25——#35 同族，框架默认值都替你踩过）、结构化校验收敛到 schema（zod/pydantic）、human-in-the-loop 各有门（canUseTool / interrupt / Crew human_input）、token 记账全白送。手写踩过的坑，三家都以某种形态接住了——除了**任务设计、业务正确性、硬边界**（CrewAI 文档对沙箱只字未提，和 §3 的发现同款空白）

数据槽：LangGraph 的 `Annotated` reducer = 我 langgraph-planner.ts 的 `Annotation.Root` merge channel（概念同构声明异构）；OpenAI Agents SDK 的 `Runner` 循环+handoffs = 我模块 03 while dispatch + 模块 10 spawn 委派；CrewAI 的 hierarchical `Process`(manager_llm) = 我模块 10 composite 产线（角色编排把我手写的流水线摊平成配置）。


## 5. 对照表：「我手写的 X = 框架里的 Y」（横评收官）

- 产出一张全仓对照表（agent 循环/上下文管理/记忆/规划/多 agent/evals/trace/护栏 × 手写件/SDK 概念）
- 每行要能回答：框架替我封装了什么、我手写时踩的哪个坑它解决了、哪个坑它也没解决
- 面试用法：表在手，「你用过框架吗」变成「我拆过框架」

### 实做记录（2026-10-27）

全表落独立文件 [MAPPING.md](MAPPING.md)（10 维度 × 40+ 行，大表不塞 TUTORIAL——沿用 §2 probe 拆文件先例）。三列编码三问：手写 X（模块/文件）/ 框架 Y（五家缩写）/ 坑判决（✅ 解决 / ⚠️ 一半 / ❌ 没管），每行坑判决回链对应 PITFALLS 或 §1~4 实录。

收官判决（全表数完行之后浮出来的形状）：

1. **✅ 普遍收走的 = 「想清楚一次就能固化」的部分**：循环骨架、schema、usage 记账、检查点序列化、human-in-the-loop 门——五家全给，因为它们不依赖你的业务
2. **⚠️ 收一半的都有同款裂缝**：重试（机制收走、判据自理）/ 记忆（存储收走、内容自理）/ trace（平台 UI、本地无损自己留）——裂缝位置就是框架假设到你业务为止
3. **❌ 五家全空的一列恰好是二阶段手写件的价值清单**：任务设计、业务正确性、硬边界、注入防御、failover、evals 判据、成本聚合——横评主线结论在表上得到逐行验证，不是口号
4. **维度级发现：06 上下文管理在 TS 家没有对应物**（只有 Crew `respect_context_window` 一个布尔）——五个维度里唯一「全空白 + 单点覆盖」的，自己造轮子造得最值的一层


## 6. 毕业项目：四件套全用 + 真实可用

- **候选**（开工前定死一个）：
  - A 个人研究助理：cron 定时醒 → 多源检索 → 多 agent 成稿 → 记忆累积偏好，越用越懂你
  - B 代码库 PR 审查 agent
- 四件套映射：上下文管理（06）/ 记忆（07）/ 规划（08）/ 多 agent（10）各在哪一层上岗——毕业项目的架构图就是二阶段的目录
- 复用不是重写：composite 产线 / ContextManager / 记忆通道都是现成零件，capstone 是组装 + 交付
- 引导问题：真实用户是谁（哪怕只有你自己）？「越用越好」的反馈回路在哪一环闭合？
- 决策记录：选型 ____，理由 ____，砍掉的候选为什么砍 ____

### 实做记录（2026-10-27）

**选型：A 个人研究助理（融合形态）**。理由：贴双期身份——学习素材与转行作品集都是 AI 领域，产线每天给自己生产学习情报，「真实用户」从第一天就是自己（§8 验收的一周真实使用天然成立）；数据源全是稳定 API（调研实见下）；四件套映射最全。砍掉的：B PR 审查 agent（工程含量高但没有每日 PR 流吃狗粮，真实使用回路不闭合）；用户最初提的生活助理四场景按权重拆解——新闻汇总升格为骨架主干，文案助手（对象消息/周报/KPI）降为二期并入同一记忆库，天气出行做晨报一句话板块，吃推荐砍（数据源脆、频次低）。

**交付形态调研**（用户授权实测，curl 实打非文档推断）：

| 验证项 | 结果 | 判决 |
|---|---|---|
| Server酱 | 官网活跃（2024-12 还在更新）、免费每天 5 条、一发 HTTP GET、企业微信应用通道微信里直接收 | ✅ 通知通道 |
| HN Algolia / GitHub API / arxiv / LangChain blog | 200/2.6s · 200/0.9s · 200/6.6s · 200 | ✅ 直连源主力（arxiv 慢，二期开） |
| 量子位 / 机器之心 RSS | 403 反爬 / 302 跳产品页（RSS 已死） | ❌ 弃——网页源全军覆没，API 才是 agent 的口粮 |
| 智谱 web_search（真 key） | error 1113 余额不足——**GLM Coding 包月不含搜索按量计费**（0.01 元/次） | 拍板 B 路线：不充值纯直连，英文条目由 researcher 附中文翻译点评 |
| uniapp H5 / App / iOS | H5 原生 EventSource / App `uni.request` enableChunked+onChunkReceived（3.99+），不通降轮询 / iOS 99 美元/年 | ✅ H5 优先 + Android 按需 |

**架构判决**：手机后台跑定时任务三堵墙（iOS BGAppRefresh 不保证时间、国产 ROM 杀后台、key 打进 App 包等于公开）→ 产线落 PC。终版链路：

```
Windows 任务计划 09:00 → daily-brief 产线（Node，fanout 4 主题）→ 日报落盘 reports/
  → Server酱推「已生成」→ 微信点开 uniapp H5 读报
  关机兜底 = server 补跑按钮；演进路径 = VPS/云函数（模块 11 知识）
```

四件套映射：06 输入侧筛选截断→researcher top25 进 prompt / 07 文件型记忆→[subscriptions.json](daily-brief/subscriptions.json) 订阅清单（用户可增删的偏好数据）/ 08 cron 触发+zod 自修一轮+花括号切片→任务计划+researcher 输出契约 / 10 composite 产线→researcher·writer·critic 三角色 + 按主题 fanout。分工变更：uniapp 端原计划用户自写，2026-10-27 改为 Claude 全栈生成、用户主审。

**产线 v1 真跑**（[daily-brief/pipeline.ts](daily-brief/pipeline.ts)，GLM glm-5.3）：4 主题源全通（原始 25/10/10/12 条 → 精选 7/7/7/6），researcher 四发零自修；critic 一审打回（逮到真问题：低星项目质量参差、转述夸大——也暴露 GLM judge 自身偏差：把 2026-10-27 当「未来日期无法核实」），writer 按意见重写后过审（重写版自觉加了【转述报道/一手研究/社区项目】信源标签 + 「star 未核验」诚实声明）。总账：**8 次调用 · 15906/17323 tokens · 347s**。critic 程序断言三件（URL ⊆ 原始池防编造 / 空板块 / 字数下限）全程零触发——LLM 质检管「好不好」，程序断言管「真不真」，11 的判据锚契约分层判决在产线上岗。

## 7. 前端交付：SSE 流式 + 过程可视化（你的主场）

- **SSE 流式渲染**：streamText 的输出流怎么变成打字机；断线重连怎么做
- **工具调用可视化**：用户能看见 agent 正在干什么（step 事件 → UI 时间线）——黑盒 agent 的信任问题用透明度解决
- **会话 API 设计**：断线重连、idempotency（同一条消息重发不重复扣费/重复执行）
- 引导问题：SSE vs WebSocket 选型？流中断在 token 中间怎么办？
- 数据槽：首字延迟 ____ms；断线重连恢复位置 ____（精确到 token/步）

### 实做记录（2026-10-28）：server 侧全链落地

**四件交付**（uniapp 端另轮）：

1. **progress 事件总线**（[pipeline.ts](daily-brief/pipeline.ts)）：产线各阶段 append `progress-日期.json`（start/researcher×N/writer/critic/done/notify）——**文件即总线**：cron 起的产线与 server 是两个进程，谁触发的产线 server 都能 fs.watch 到，不绑定 spawn 关系。emitProgress 串行队列防 fanout 并发写竞态（08 金笔记②的复发防御，P5 探针回归）
2. **[server.ts](daily-brief/server.ts)** 零依赖原生 http（09「能不用框架就不用」路线）：`GET /api/latest`（日报全家桶 md+status+progress+running）/ `/api/report?date=` / `/api/history`（台账）/ `/api/topics`（GET 读 + POST zod 校验整体替换——07 订阅清单的增删改入口）/ `/api/progress`（**App 端 SSE 不通时的轮询降级通道**）/ `/api/events`（SSE：连接即回放全量 + fs.watch 增量 diff 广播 + 18s 心跳注释行）/ `POST /api/run`（补跑：spawn 产线子进程，**已在跑 409 防重**）/ `/`（uniapp 构建产物优先，没有给内置占位页——浏览器直开 8787 就能读报）
3. **Server酱通知**（pipeline main 尾部）：标题进微信卡片 + desp 放今日总评 + 打开链接（BRIEF_PUBLIC_URL 配局域网地址手机才点得开）；SCT_SENDKEY 缺省 no-op（11 langfuse 同款纪律：通知层绝不炸产线）。真发验证见下方实录
4. **[register-task.ps1](daily-brief/register-task.ps1)**：每天 09:00 任务计划（StartWhenAvailable 开机补跑——「关机兜底」的另一半是补跑按钮）。已注册 + schtasks /Run 全链实跑 exit 0（两坑修复实录见 git log：无 BOM UTF-8 被 PowerShell 5.x 按 GBK 解析炸解析阶段；Split-Path 层数错一层跑到 E:\workspace，node 找不到脚本秒退——任务计划黑盒里只剩「闪一下」）

**验收实录**（零 token 端点 7/7 + 真跑两发，第二发暴露可靠性缺口又白捡修复实录）：latest/history(3 runs)/topics(4)/progress/404 路由提示/占位页/坏载荷 400 全过；`POST /api/run` spawn 补跑 + 二连发 409 防重；**SSE 三验**——连接即回放（中途连上也能看全程）、18s 心跳防中间层掐线、实时增量流实测（SSE 先连 26s 后产线才启动，start + researcher×3 事件实时到达）。

**补跑第一发 exit 1（坏事变教材）**：ai-agents 主题 chat 层抛错把整条产线带走——progress 停在第 4 条事件、history 没入账、`stdio:'ignore'` 还吞了崩溃现场。两个缺口都是 fetch 层修了 researcher 层漏了：① researchTopic 无失败降级（spawn.ts 失败传播三入口的教训没搬全）→ 修为 try/catch 降级空板块（单主题崩≠全链崩）② main 无兜底 → catch 落 error 事件（SSE 可见）+ exit 1 ③ server spawn 改日志管道转发（崩溃现场必须可观测——`stdio:'ignore'` 是自己给自己挖的黑盒）。**修复后第二发 exit 0 全链 9 事件**（start/researcher×4/writer/critic 一审过审/done/notify），history 第 4 条入账 6 调用 9586/9358/103s。**Server酱真发验证通过**（用户已配 SCT_SENDKEY/BRIEF_PUBLIC_URL，补跑成功推送落微信）。

**数据槽**：SSE connected 即时；watch→广播毫秒级（fs.watch 触发即推，实测无感知延迟）；进度粒度=**阶段级不是 token 级**——设计取舍：§1 streamText 的 token 流是「盯生成」场景，cron 日报是「生成完来看」场景，阶段级时间线够用省实现；打字机留给未来「盯跑」模式。

**坑两枚**（实录进代码注释）：① spawn 产线子进程 cwd 必须钉死仓库根——dotenv 从 cwd 读 .env，任务计划默认 cwd=system32（server 的 spawn 和 register-task.ps1 的 -WorkingDirectory 都显式钉了）；② pipeline 底部 main() 无 isMain 守卫时，任何 import 它的文件（probe/server）都会把产线真跑一遍——「入口即库」的文件必须显式分家（spawn.ts 先例，昨日实录烧 29k token 学费）。

### 实做记录（2026-10-28）：uniapp H5 端——三页面 + SSE 进度 + 静态托管

**交付**（[daily-brief/app/](daily-brief/app/)，独立子项目——依赖与构建产物不进根仓 node_modules）：

- **三页面**（[pages.json](daily-brief/app/src/pages.json) text-only tabBar：日报/订阅/台账）：report（日期 picker 翻历史 + 补跑按钮 409 提示 + 进度时间线 emoji 图标 + marked→v-html + critic verdict fail 黄条 + onShow 检测非终态自动开进度流）/ topics（增删改 + 前端必填校验 + 后端 zod issues 展示双层）/ history（totals 四卡 + runs 反序列表 pass/fail 标签）
- **[api.ts](daily-brief/app/src/api.ts)**：watchProgress 双通道——`typeof EventSource !== 'undefined'` 走 SSE（坏包 catch 不炸流），否则 3s 轮询 diff 增量（§6 调研结论 App 端降级通道落地）；isTerminal 用事件流判定生成中（server 的 running 字段只覆盖它自己 spawn 的，cron 起的它不知道）
- **构建链路**：@dcloudio 全家（uni-app/uni-components/uni-h5/vite-plugin-uni/uni-cli-shared）版本串统一 `3.0.0-5030320261023001`（vue3 dist-tag——**全家必须同串**，差一位就 ERESOLVE）+ @dcloudio/types 精确 3.4.31（peer 要求精确版，^ 都不行）

**三个决策**（都进了 [vite.config.ts](daily-brief/app/vite.config.ts) 注释）：

1. **dev proxy `/api`→8787**：页面全部相对路径 `fetch('/api/...')`——dev 时 vite 转发、prod server 托管同源直连，**代码零环境分支**，CORS 都不用想（server 侧的 CORS \* 是给 H5 dev 5173 跨域兜底的）
2. **hash 路由**（manifest.json `h5.router.mode`）：纯静态托管免「刷新 /#/topics 回退到 /」的服务器回退规则
3. **marked 渲染 + XSS 信任边界声明**：日报是自产线产出（critic + URL⊆原始池程序断言），非用户输入——v-html 的信任边界写在注释里，不是无意识裸奔

**坑三枚**（都是构建工具坑不是 agent 坑，PITFALLS 不收）：① vite-plugin-uni CJS `module.exports={default:fn,...}` 形状，esbuild 打包 vite.config 时 default import 拿到整个对象（「uni is not a function」）→ `(uniRaw as any).default ?? uniRaw` 剥层；② build.outDir 配了 'dist' 但产物落 **`dist/build/h5/`**——uni 插件强制约定路径，outDir 拗不过它 → server.ts 按约定路径适配（别跟插件较劲，读它的约定）；③ npm ERESOLVE 指着 types 版本——看 peer 字段要的是精确 "3.4.31"，^3.4.32 也不行。

**验收**（HTTP 层 curl 全通，最终人眼验收留给用户）：`GET /` 返回真 index.html（非占位页）+ 主 JS 220KB + 两份 CSS 全 200；/api/latest（今日真日报）/history（5 runs 36 calls）/topics（4 主题）数据环闭合。浏览器开 `http://localhost:8787` 或手机同 WiFi 开 `http://192.168.19.154:8787`（Server酱卡片里的链接就是它）。

## 8. 验收：真实用户一周 + 博客

- 真实用户持续用一周（自己也算，但要真的用）
- 博客一篇：架构 + 踩坑（PITFALLS 就是素材库）
- 二阶段收官句：从「懂原理 + 写过 demo」到「能独立开发真实可用的 AI 系统」——最后一步是有人真的在用

## TODO 索引

- [x] ① Vercel AI SDK 重写 mini_agent + streamText 冒烟（2026-10-26，一发全通，对照发现 6 条见 §1）
- [x] ② LangGraph.js 重写 planner-executor + checkpointer 对照（2026-10-27，探针 9/9 + 真链 interrupt 恢复全通，#34 落 PITFALLS）
- [x] ③ Claude Agent SDK 试跑（2026-10-27，GLM anthropic 端点验通真跑，三版迭代全链通过，PITFALLS #36）
- [x] ④ Python 三框架概念对照（2026-10-27，阅读级零烧，概念全数映射回手写件，无生词）
- [x] ⑤ 全仓对照表落档（2026-10-27，MAPPING.md 10 维度 40+ 行，坑判决三档编码三问）
- [x] ⑥ 毕业项目选型 + 搭建（2026-10-27，选型 A 融合形态 + 调研三件全落定 + daily-brief 产线 v1 真跑验收 8 调用 33k tokens）
- [x] ⑦ 前端交付（SSE / 可视化 / 会话 API）（2026-10-28，uniapp H5 三页面 + SSE 双通道 + 静态托管 curl 验收全通）
- [ ] ⑧ 一周真实使用 + 博客 + 收官
