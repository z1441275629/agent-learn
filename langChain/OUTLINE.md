# LangChain / LangGraph 实践大纲（面试向）

> 2026-11-12 定稿。目标：**面试时能把业界主流 agent 框架讲透、用熟**；顺带给 pa 扩展或下一个正规项目打底。
> 语言路线：**TS 主练**（LangChain.js / LangGraph.js，产物可直接长成项目），**Python 速览**（一晚，概念 1:1 只对差异）。
> 节奏：每周 5~8h，约一站/周，全程 8~10 周。练习产物都留在 `langChain/`（沿用 chroma/ 的「先练习后实验」模式，不直接动 personal-agent）。

## 0. 你的差异化故事（先想清楚再练）

你已经手写过：agent 循环（core/agent.ts）、工具注册表+确认门、BM25+向量混合检索、上下文压缩、长期记忆、技能系统（skills.ts）、MCP client/server、planner-executor、多 agent 编排（composite）、定时任务。

所以这份大纲的学法不是「从零学框架」，而是每一站都做三件事：
1. **概念**：框架的这个抽象是什么、解决什么问题
2. **动手**：用框架写一个最小可运行版本
3. **对照**：它跟你手写的哪个部分同构？它多给了什么（checkpoint/时间旅行/生态）？你手写的哪个决定它没有（成本护栏/熔断/fail-closed 语义）？

「我先手写了一遍，再学框架，知道每个抽象在解决什么」——这句话就是面试的锚点。第 3 步的对照结论直接进当天复盘（reviews/），攒成面试弹药。

## 1. 全景图（2026-11 核实自官方文档 docs.langchain.com）

LangChain 系现在是**三层产品线 + 一个平台**，面试开场能画出来就赢了 half：

| 层 | 是什么 | 一句话定位 |
|---|---|---|
| **LangChain**（`langchain` npm 包） | agent 框架：`createAgent` 最小 harness + middleware 组合 | Agent = Model + Harness，按需加能力 |
| **LangGraph**（`@langchain/langgraph`） | 底层编排运行时：StateGraph、持久化、interrupt、流式 | 确定性步骤+模型驱动步骤混排；LangChain 的 agent 就建在它上面 |
| **Deep Agents**（`deepagents` 包） | 带电池的 harness：虚拟文件系统、子代理、skills、memory | LangChain 官方对 Claude Agent SDK 同型物的回答 |
| **LangSmith** | 平台：tracing / 评测 / Studio / 部署 | 跨框架可观测，`LANGSMITH_TRACING=true` 即接入 |

**版本演进线**（面试常问「LangChain 经历了什么」）：
- 0.1（2023）：chains 大杂烩（LLMChain/AgentExecutor/Legacy Memory）
- 0.2/0.3（2024）：拆包（langchain-core / langchain / 独立集成包），LCEL Runnable 协议
- 1.0（2025-10）：**推倒重来**——`createAgent` + middleware 为中心，LangGraph 独立成编排运行时，旧 AgentExecutor/LLMChain/Legacy Memory 全部废弃，Deep Agents 发布
- 之后：Deep Agents 壮大（skills 对齐 Agent Skills 标准、AGENTS.md memory）、LangSmith Studio/Engine

**避雷**：网上大量教程还是 0.x API（AgentExecutor、ConversationBufferMemory、LLMChain、`initialize_agent`）。面试提旧 API 直接减分；看到旧教程要能认出来并换算到 v1 对应物。

## 2. 核心知识地图（按面试出现频率排序，★=必须能白板讲）

每行标注「↔ 手写对应物」——这是你的复习捷径，也是对照练习的索引。

| # | 核心知识 | 属于 | ↔ 你手写的 |
|---|---|---|---|
| 1 ★ | `createAgent` 工具循环：model/tools/prompt/middleware 四件套 | LangChain | core/agent.ts runToolLoop |
| 2 ★ | middleware 体系：retry / HITL / summarization / 自定义 / 状态扩展 | LangChain | 确认门、上下文压缩、chatterGate |
| 3 ★ | LangGraph 状态机：StateSchema / Reducer / 节点 / 边 / 条件边 / Send(map-reduce) / Command | LangGraph | 路由三态 + plan 串行链 |
| 4 ★ | 持久化：Checkpointer / thread_id / Store（跨线程长期记忆）/ 时间旅行 | LangGraph | sessions 账本 + memories.ts |
| 5 ★ | Human-in-the-loop：`interrupt()` + `Command({resume})` | LangGraph | 确认门（fail-closed 语义对比是金句） |
| 6 ★ | 多 agent：SubAgentMiddleware / supervisor / handoffs / deepagents `task` 工具 | 全线 | composite（研究员→审校→写手）+ planner |
| 7 ★ | RAG：retrieval / vector store 集成 /（你已有混合检索实战） | LangChain 集成层 | rag.ts + vector-lane（69 chunk 实测数据直接当案例讲） |
| 8 | 流式：streamMode（values/updates/messages）/ event stream / 前端协议 | LangGraph | SSE 帧协议（delta/tool/done 帧） |
| 9 | Deep Agents 全家桶：虚拟文件系统+权限、skills（SKILL.md!）、memory（AGENTS.md）、上下文卸载 | deepagents | skills.ts 技能系统 + 记忆 + 压缩——**你会发现自己手写的机制与官方标准同构** |
| 10 | 可观测与评测：LangSmith tracing / eval / Studio | LangSmith | TTFT 落盘、usage 账本 |
| 11 | 结构化输出：zod schema → responseFormat / withStructuredOutput | LangChain | planner 严格 JSON 步骤表 |
| 12 | 部署形态：`langgraph dev` 本地 server / Agent Chat UI / LangSmith Deployment | LangGraph | pa 的 Koa 服务（对照着理解 Agent Server 的 threads/runs API） |

## 3. 实践路线（11 站）

每站产出：一个可运行文件 + 当天 `/learning-review` 复盘（对照结论进复盘，就是面试弹药）。

### S0 环境 + 追踪（0.5 晚）
- `langChain/` 里 npm init，装 `langchain zod @langchain/langgraph @langchain/openai`
- 模型接方舟 GLM：`ChatOpenAI` 传 `configuration.baseURL/apiKey`（方舟是 OpenAI 兼容端点，你 09-harness 同款路线）；顺手试 provider 前缀写法（你 agent.ts 里 `baseten:zai-org/GLM-5.2`）
- 注册 LangSmith 免费层，`LANGSMITH_TRACING=true` + API key，把现有 agent.ts 跑通一次，网页里看到 trace
- **验收**：trace 里能看到完整 agent 树（模型调用/工具调用嵌套）

### S1 createAgent 工具循环（1 周）
- 最小 agent：2 个 zod 工具（一个只读一个写入），invoke + stream
- 对照 core/agent.ts：框架帮你做了什么（工具 schema 生成、循环终止、消息回填）？没做什么（你的同轮并发/串行策略、write 过门——框架默认全放行）
- 结构化输出：responseFormat 传 zod schema，对照 planner 的严格 JSON + fail-closed
- **验收**：流式打字 + 工具调用 + 结构化输出三合一跑通；能说出与手写循环的三处差异

### S2 middleware 体系（1 周）
- 内置件逐个试：`toolRetryMiddleware` / `modelRetryMiddleware` / `humanInTheLoopMiddleware` / summarization
- 写一个自定义 middleware（比如工具调用计数或成本记账），理解 wrapModel/wrapTool 钩子
- 对照：middleware 本质是「把你的 chatterGate/压缩从主循环里抽成可插拔层」——你们 pa 是硬编码在 chat-service，框架是组合式
- **验收**：自定义 middleware 生效；能讲「middleware 解决了 agent 能力的组合性与复用」

### S3 LangGraph 状态机（1.5 周，本线重头之一）
- `StateGraph` + `StateSchema`（`MessagesValue`、自定义 Reducer——对照你账本的 append 语义）
- 手写三节点图：路由→处理A/B→汇总；条件边；`Send` 做 map-reduce 并行（你手写没造过的东西，重点练）
- 把 pa 的「路由三态」画成一张图跑起来（normal/plan/composite 三条边）
- 子图：把 composite 编排（研究→审校→写手→审校）做成子图挂进主图
- **验收**：一张含条件边+Send+子图的图可运行；能白板画出 pa 全链路的 LangGraph 版本

### S4 持久化 + 时间旅行（1 周，你手写完全没造过的，面试最大增量）
- `MemorySaver` → SQLite checkpointer；thread_id 隔离会话；进程重启后接着聊
- Store：跨 thread 长期记忆，对照 memories.ts
- 时间旅行：getState/history，从历史 checkpoint 重放/分叉
- 对照：你的 sessions 账本是「业务层快照」，checkpointer 是「执行层快照」——粒度（每 superstep）和用途（恢复/重放/分叉）不同
- **验收**：杀进程重启续聊成功；从中间 checkpoint 分叉出第二条对话线

### S5 interrupt HITL（0.5 周，快站——你已有深理解，主要是学 API）
- `interrupt()` 暂停写入工具前，人批后 `Command({resume})` 继续
- **对照讨论（面试金句素材）**：框架 interrupt 默认语义 vs 你的 fail-closed（无门/抛错/超时/断流一律拒绝）——「框架给了暂停点，放行策略还是要接入方自己定」，这正是你 09 以来的原则
- **验收**：暂停-批准-继续全流程跑通

### S6 多 agent + Deep Agents（1.5 周，重头之二）
- LangChain 多 agent 三模式：subagents / handoffs / supervisor（官方教程：customer support handoffs、personal assistant subagents）
- Deep Agents：`create_deep_agent` 起一个，体验 `task` 子代理工具、AGENTS.md memory、SKILL.md skills、`interrupt_on`
- **重点对照**：deepagents 的 skills（Agent Skills 标准：SKILL.md frontmatter 索引+按需加载全文）跟你 skills.ts 的机制几乎逐条同构——面试讲「我在手写实现后才发现官方标准长这样，验证了机制设计的必然性」，这是顶级素材
- 对照 composite：你的修订熔断 ≤2 轮 + 成本护栏 + maxCalls 机械闸，deepagents 没有内置——「框架管编排，护栏得自己加」
- **验收**：一个 deep agent 带 2 个自定义 subagent + 1 个 skill 跑通；一张「pa 机制 ↔ 官方机制」对照表

### S7 RAG 站（0.5 周，快站——你比多数面试官熟）
- 走一遍官方 retrieval 路线（文档加载/splitter/vector store 集成），接你已有的 Chroma
- LangSmith eval：建一个小 dataset，跑一次评估实验
- **面试讲法**：直接甩 69 chunk 实测——向量为主 BM25 补位、等权 RRF 被弱路拖累、PITFALLS #63「先验自带隐含实验条件」。再补一句框架视角（retriever 抽象让混合策略可替换）
- **验收**：LangSmith 里有一次完整 eval 实验

### S8 流式 + 前端（0.5 周）
- streamMode：values/updates/messages 三种粒度各跑一次，custom stream channel 自定义事件
- 起官方 Agent Chat UI 连本地 graph，或用 `@langchain/langgraph-sdk` 写个 50 行前端
- 对照：你的 delta/tool/done 帧协议 vs 框架的多通道流——「我设计帧协议时踩的边界（工具帧与文本帧交错）框架用通道解决」
- **验收**：前端实时收到 token 流 + 工具事件

### S9 毕业项目（2 周，作品集，正规点的那种）
从下面挑一个（或自己定），按正规工程做：README、类型齐全、LangSmith 接入、基本测试、`langgraph dev` 可跑：
- **A. LangGraph 重写 pa 的博客编排**：路由三态 + composite 子图 + interrupt 写门 + checkpointer 持久化，与 pa 手写版写一篇对比博客（你有现成素材链）
- **B. 独立小项目**：一个「每天真用一次」的 agent（延续三阶段原则），用 Deep Agents 起步、LangGraph 深度定制
- 面试讲法：白板画架构图 + 讲三个工程决定（为什么这里用框架、那里手写）
- **验收**：能当作品集展示；对比博客或项目文档落库

### S10 Python 速览（1 晚）
- 同一 createAgent / StateGraph / interrupt 在 Python 的样子（`create_agent` 蛇形命名、`@tool` 装饰器、langgraph-checkpoint-sqlite 等独立包）
- 整理一张 TS↔Python API 对照表（放本目录）
- 了解生态差异：教程/岗位 JD 多为 Python first，核心概念完全一致
- **验收**：Python 跑通一个 create_agent + interrupt 最小例；被问「你们用 TS，我们用 Python」能答「概念层无差，主要是包名与命名约定」

## 4. 面试弹药库（随练习攒，S9 时整理成一篇博客）

- **对照表**：pa 手写机制 ↔ 框架机制（S3/S4/S5/S6 各攒一张，最后合并）
- **高频题自测清单**（每题要求：先答概念，再补「我手写时的情况」）：
  - LangChain/LangGraph/Deep Agents 分层与选型？什么时候不用框架？
  - checkpointer 怎么工作？thread 状态和长期记忆（Store）的区别？
  - interrupt 恢复流程？暂停期间状态存哪？
  - Send 和条件边都能分支，差别？（并行 fan-out vs 单路选择）
  - middleware 能做什么、不能做什么？
  - 你的混合检索为什么不用 RRF？（已有）
  - 框架 agent 上生产缺什么？（成本护栏、机械终止闸、投毒防御——你都实装过）
- **旧 API 避雷卡**：AgentExecutor→createAgent；LLMChain→LCEL/直接模型调用；ConversationBufferMemory→短期(thread state)/长期(Store)二分；`initialize_agent`→不存在了

## 5. 资源

- 官方文档（2026-11 核实有效，TypeScript 侧）：
  - LangChain 总览/quickstart/middleware：https://docs.langchain.com/oss/javascript/langchain/overview
  - LangGraph 全能力（persistence/interrupts/streaming/time-travel...）：https://docs.langchain.com/oss/javascript/langgraph/overview
  - Deep Agents（tools/skills/memory/subagents/HITL）：https://docs.langchain.com/oss/javascript/deepagents/overview
  - 文档全量索引（喂给 agent 用）：https://docs.langchain.com/llms.txt
- LangChain Academy（免费课，Python 为主但讲概念）：https://academy.langchain.com/
- 概念对照阅读：Deep Agents vs Claude Agent SDK（官方有专页）——你天天用 Claude Code，这篇对照会非常有共鸣

## 6. 纪律（沿用三阶段）

- 每站完成后 `/learning-review`，对照结论必须写进复盘（那是弹药本体）
- agent 开发相关的坑照旧自动记 PITFALLS（比如框架坑：checkpointer 序列化限制、interrupt 里 async 陷阱之类，踩到就记）
- 语言/运行时语法类坑不记（PITFALLS 范围纪律不变）
- 不跑全量验证金字塔；练习代码以「跑通+复盘」为验收，S9 毕业项目才上正规工程标准
