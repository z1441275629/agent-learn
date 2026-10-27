# 手写 X = 框架里的 Y · 全仓对照表（模块 12 §5 收官产出）

> 读法：每行三列回答横评三问——**手写 X**（模块/文件）是什么；**框架 Y**（谁家的什么概念）把它封装成了什么；
> **坑判决**（✅ 它解决了我踩的坑 / ⚠️ 只解决一半 / ❌ 它也没管）。
> 缩写：AI SDK = Vercel AI SDK · LG = LangGraph(.js，§4 已验 Python 同构) · CAS = Claude Agent SDK · OAI = OpenAI Agents SDK · Crew = CrewAI。
> 主线结论先挂这：**轻量 SDK 管循环、LG 管状态、CAS 管权限——任务设计、业务正确性、硬边界三样没人替你管。**

## 0. 模型调用与工具协议（01 / 02 / 04 / 05）

| 手写 X | 框架里的 Y | 坑判决 |
|---|---|---|
| 手拼 JSON Schema + tool_calls 解包（01 tool_call.ts） | AI SDK `tool({inputSchema: z.object()})`；CAS `tool()`；OAI/Crew pydantic | ✅ 类型即 schema 一处维护，拼错 tsc 当场逮——zod/pydantic 收敛是五家共识 |
| 手写 MCP server：JSON-RPC 帧握手 + tools/list（04 server.ts） | CAS `createSdkMcpServer` 一行 = MCP + registry 合体 | ⚠️ 协议帧全吞，但 defer 到 ToolSearch 的默认坑是它自己挖的（#36 v1，GLM 搜不到卡死 106s） |
| SKILL.md 渐进披露（05） | CAS Skills（模块 5 已对照） | ✅ 同概念官方化 |

## 1. Agent 循环（03 mini_agent → §1 重写）

| 手写 X | 框架里的 Y | 坑判决 |
|---|---|---|
| while 循环 + dispatch 查表 + parse + try（03 mini_agent.ts） | AI SDK `generateText` + `stopWhen`；OAI `Runner.run`；Crew `kickoff()` | ✅ 循环/查表/解析/异常反馈全收走；业务 prompt 一行不省 |
| 步数保险 `if step > N break`（03） | `stopWhen: stepCountIs(8)` / `maxTurns` / `max_iter` 20 / `recursionLimit` 25 | ✅ 家家有默认值——但图形态的 recursionLimit 按节点执行计是隐性税（#35） |
| 手拼 messages 数组滚动（03） | 被封装吞掉（AI SDK 开 include 才可见） | ⚠️ 便利换透明——模块 3 亲眼看数组滚动的教学价值框架不给你 |
| usage 手记（03 版本：躺在 response 里没取） | `onStepFinish` / `result.usage` / num_turns 白送 | ✅ 最反直觉的一课：框架默认给的正是手写没想到要的（观测要刻意设计） |
| —（无对应手写） | AI SDK v5→v7 `promptTokens`→`inputTokens` | ❌ 框架 API 自己也在漂移——升级框架和升级模型一样跑探针，不豁免 |

## 2. 上下文管理（06 ContextManager）

| 手写 X | 框架里的 Y | 坑判决 |
|---|---|---|
| 滑动窗口/截断/compaction 摘要压缩（06 context.ts） | Crew `respect_context_window` 一个布尔 | ⚠️ 摊平成配置最省心；AI SDK/LG/OAI 全空白——**TS 家没有对应物，06 是自己造轮子的维度** |
| 防注入指令隔离（11 §5 实攻后加的） | 无（Guardrails 是校验不是隔离） | ❌ 五家都没内建——注入防御全靠自己 |

## 3. 记忆（07 双通道）

| 手写 X | 框架里的 Y | 坑判决 |
|---|---|---|
| 文件型 memory.md + 检索型 BM25/vector 双通道（07 memory.ts/bm25.ts） | OAI Sessions（自动工作记忆）；LG store（跨线程持久）；Crew memory 三层 short/long/entity | ⚠️ 全家的「记忆」都是存储层——07 的同义合并/去重（test_dedup）谁家都没有，内容管理还是自己的事 |

## 4. 规划（08 planner-executor → §2 重写）

| 手写 X | 框架里的 Y | 坑判决 |
|---|---|---|
| makePlan/execute/replan 调度 + if 重规划（08 planner.ts） | LG StateGraph 四节点 + 条件边（§2 实做） | ✅ 骨架收走；但 channel 无首赋值 = undefined 参与路由是图形态新坑（#34，手写 `let replans=0` 语法强制反而安全） |
| saveCheckpoint 20 行手写存档（08） | LG checkpointer 一个参数（序列化/快照/恢复全白送） | ✅ 09 的会话存档 resume 同款收走 |
| 重试打勾 + 保 done 不重跑 + 步间交接（08） | 原样搬运，一行没省 | ❌ 「框架管状态怎么流，不管业务对不对」——§2 实证 |
| zod 校验 + 自修一轮（08） | OAI Guardrails（输入/输出校验，与主调用并行、fail fast） | ⚠️ 机制官方化了，但校验判据本身还是自己写 |
| 围栏剥除/花括号切片（08 保险，§2 增补复课） | 各家 parse 工具都有 | ❌ 谁家都没彻底解决——n=1 方差仍靠探针兜底（§2 重构版当场炸 json 围栏实录） |
| planner-executor 整件 | Crew `planning=True`（AgentPlanner 预计划）；Deep Agents 内建 planning | ✅ 摊平成配置；可干预度相应归零 |

## 5. 多 Agent（10 → §2 Send 增补 / §4）

| 手写 X | 框架里的 Y | 坑判决 |
|---|---|---|
| spawn 委派，子 agent 当工具调（10 spawn.ts） | OAI handoffs（一等公民：类型/追踪/校验都认） | ✅ 机制相同官方形状化 |
| fanout Promise.all 并行（10 fanout.ts） | LG `Send` fan-out 把并行升进图拓扑（§2 增补） | ⚠️ 并发写归并语义必须声明——`InvalidUpdateError` 显式报错 vs 手写静默覆盖（模块 8 金笔记②），框架把隐性竞态变显式是升级 |
| composite 产线 chargeR/chargeW + critic settle（10 composite.ts） | Crew hierarchical Process + manager_llm（协调/委派/验证） | ✅ 管理者模式官方化；critic 判官的判据设计还是自己的 |
| SpawnResult token 双栏 + ×N 账本（10） | usage 白送，但跨 agent 成本聚合要 Langfuse 层 | ⚠️ 单次记账收走，聚合分析平台才给 |
| supervisor / pipeline 五模式（10） | LG 图形态自由拼；Crew Process sequential/hierarchical 二选一 | ⚠️ 图全自由全自理；Crew 全托管二选一——光谱两端，10 的手写件在中间 |

## 6. Evals（11）

| 手写 X | 框架里的 Y | 坑判决 |
|---|---|---|
| evals 三 case + 判据锚契约（11 evals.ts） | LangSmith / Langfuse evals（数据集+跑分跑道） | ❌ 平台给跑道不给方向盘——判据设计、锚契约、失败归因全是手艺 |
| LLM-as-judge + 偏差控制（11 judge.ts） | Langfuse evals 可挂 judge 模型 | ❌ 偏差控制（判官校准/一致性检查）平台不管 |

## 7. Trace 与可观测（11 → §4）

| 手写 X | 框架里的 Y | 坑判决 |
|---|---|---|
| TraceCollector：spawn/event/conclude 落盘 JSON + flow txt（11 trace.ts） | Langfuse OTel span/generation/event（11 §4 双写实做）；OAI 内建 tracing | ⚠️ 平台白送 UI 回放/趋势/成本聚合；手写的语义 role 名/零成本事件归因框架也吃得了，本地无损可 grep 是框架没有的那份 |
| flush 时机管理 / no-op guard（11 langfuse.ts） | 平台 SDK 的 forceFlush 纪律 | ❌ 换代期投影缺 usage（v2 实录）——本地 JSON 兜底不是过渡方案是长期双保险 |

## 8. 护栏与 Harness（09 → §3 实做）

| 手写 X | 框架里的 Y | 坑判决 |
|---|---|---|
| 工具 allowlist（09 allowlist/permissions.ts） | CAS `options.allowedTools` + CLI 内置命令分级（ls 类只读免审） | ✅ 收走还多送一层命令安全分级——手写版没有的 |
| confirm 人工审批（09） | CAS `canUseTool`；LG `interrupt`/`Command`；Crew human_input | ⚠️ 机制家家有；CAS 的坑：不显式 `permissionMode:'default'` 时 Write 静默放行（#36 v2） |
| MCP 工具全名匹配（09 registry 命名 → §3 v3 教训） | 权限层收 `mcp__server__tool` 全名 | ❌ 坑是框架自己埋的——短名匹配误拒 3 连烧穿 maxTurns |
| sandbox 目录 + 路径检查（09 sandbox.ts） | CAS `options.cwd`；OAI sandbox agents（隔离容器） | ❌ **cwd 是工作目录不是沙箱**——deny 后 Glob/Read 出界读到仓库根（#36 最扎一条）；硬边界 OS 级自己造 |
| hooks 前后拦截器（09 hooks.ts） | CAS hooks（需完整 CLI 环境，§3 未跑） | ✅ 概念同构官方化 |
| sessions/会话存档 resume（09 persist.ts） | LG checkpointer；OAI Sessions | ✅ 序列化/恢复收走 |
| 注入纵深防御三件套 + 复攻矩阵（11 §6） | 无内建 | ❌ 五家空白——攻击面（含 availability）自己扫自己防 |

## 9. 可靠性（11 reliability）

| 手写 X | 框架里的 Y | 坑判决 |
|---|---|---|
| classifyError + 退避重试（11 reliability.ts） | LG retryPolicy（节点级）；传输层重试各家 SDK 有 | ⚠️ 重试机制收走；错误分类学（哪些可重试哪些熔断）还是自己定 |
| 配额 failover 切备用档（11） | 无（Vercel 有 provider 抽象无 failover 语义） | ❌ 「没人替你管」榜首——failover/降级路由是纯手艺 |
| 大小模型路由 + 三层可观测（11） | 无直接对应 | ❌ 成本工程全自己写 |

## 收官判决

- **✅ 普遍收走的**：循环骨架、schema 定义、usage 记账、检查点序列化、human-in-the-loop 门、消息流分块——手写件里「想清楚一次就能固化」的部分
- **⚠️ 收一半的**：重试（机制收走判据自理）、记忆（存储收走内容自理）、并发安全（变显式报错但要你声明语义）、trace（平台给 UI 本地无损自己留）
- **❌ 五家都空的**：任务设计、业务正确性、硬边界、注入防御、failover、evals 判据、成本聚合——**二阶段手写件的价值清单恰好在 ❌ 列**
- 面试用法：这张表在手，「你用过框架吗」变成「我拆过框架」——每个 Y 都能说出对应 X 踩过的坑
