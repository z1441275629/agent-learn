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
- 数据槽：两版各跑同任务的 token 双栏 / 步数 / 耗时：手写 ____/____，SDK ____/____

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

## 3. Claude Agent SDK：产品级循环——和你的 09 harness 对照

- **任务**：读它的 agent 循环 + 权限 + hooks 结构（你每天在用的 ZCode 的近亲），对照模块 09 手写的壳
- 先验证：GLM 的 anthropic 兼容端点能不能喂它跑真任务；不行就纯阅读级（读结构、跑不起就不烧）
- 对照点：权限系统（你的 allowlist+confirm）、hooks（你的前后拦截器）、MCP 接入（你的模块 4）、Skills（你的模块 5）
- 引导问题：产品级 SDK 在你手写版之上多花了多少代码在「敢给别人用」上？
- 数据槽：能跑则记一次运行的账 ____/____；不能跑则记「兼容性卡点：____」

## 4. Python 阅读级：LangGraph / OpenAI Agents SDK / CrewAI 概念对照

- 不动手，读概念：三者的 agent 抽象各是什么形状（图 / runner / 角色编排）
- 你能读懂它文档里每个概念的 TS 对应物——这就是「Python 阅读力」的验收
- 数据槽：三个框架各一句「它的 X = 我手写的 Y」：____ / ____ / ____

## 5. 对照表：「我手写的 X = 框架里的 Y」（横评收官）

- 产出一张全仓对照表（agent 循环/上下文管理/记忆/规划/多 agent/evals/trace/护栏 × 手写件/SDK 概念）
- 每行要能回答：框架替我封装了什么、我手写时踩的哪个坑它解决了、哪个坑它也没解决
- 面试用法：表在手，「你用过框架吗」变成「我拆过框架」

## 6. 毕业项目：四件套全用 + 真实可用

- **候选**（开工前定死一个）：
  - A 个人研究助理：cron 定时醒 → 多源检索 → 多 agent 成稿 → 记忆累积偏好，越用越懂你
  - B 代码库 PR 审查 agent
- 四件套映射：上下文管理（06）/ 记忆（07）/ 规划（08）/ 多 agent（10）各在哪一层上岗——毕业项目的架构图就是二阶段的目录
- 复用不是重写：composite 产线 / ContextManager / 记忆通道都是现成零件，capstone 是组装 + 交付
- 引导问题：真实用户是谁（哪怕只有你自己）？「越用越好」的反馈回路在哪一环闭合？
- 决策记录：选型 ____，理由 ____，砍掉的候选为什么砍 ____

## 7. 前端交付：SSE 流式 + 过程可视化（你的主场）

- **SSE 流式渲染**：streamText 的输出流怎么变成打字机；断线重连怎么做
- **工具调用可视化**：用户能看见 agent 正在干什么（step 事件 → UI 时间线）——黑盒 agent 的信任问题用透明度解决
- **会话 API 设计**：断线重连、idempotency（同一条消息重发不重复扣费/重复执行）
- 引导问题：SSE vs WebSocket 选型？流中断在 token 中间怎么办？
- 数据槽：首字延迟 ____ms；断线重连恢复位置 ____（精确到 token/步）

## 8. 验收：真实用户一周 + 博客

- 真实用户持续用一周（自己也算，但要真的用）
- 博客一篇：架构 + 踩坑（PITFALLS 就是素材库）
- 二阶段收官句：从「懂原理 + 写过 demo」到「能独立开发真实可用的 AI 系统」——最后一步是有人真的在用

## TODO 索引

- [x] ① Vercel AI SDK 重写 mini_agent + streamText 冒烟（2026-10-26，一发全通，对照发现 6 条见 §1）
- [ ] ② LangGraph.js 重写 planner-executor + checkpointer 对照
- [ ] ③ Claude Agent SDK 阅读/试跑（端点兼容性先验证）
- [ ] ④ Python 三框架概念对照（阅读级）
- [ ] ⑤ 全仓对照表落档
- [ ] ⑥ 毕业项目选型 + 搭建
- [ ] ⑦ 前端交付（SSE / 可视化 / 会话 API）
- [ ] ⑧ 一周真实使用 + 博客 + 收官
