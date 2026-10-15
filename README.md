# AI Agent 面试准备实验室

> 目标：把「大概了解 MCP / Skill / Agent / RAG / Function Calling」变成「**能讲清原理 + 动手写过 demo**」，面试有底气。
> 开始日期：2026-09-26。预计 5 个模块，每模块 1 个晚上（2~3 小时），约 1~2 周走完。

---

## 0. 最重要的一个认知（面试的杀手锏）

这五个概念**不是并列关系，而是不同层次的东西**。面试时能把这个层次讲清楚，就已经超过大部分候选人：

```
Function Calling  —— 模型能力层：LLM 输出"我要调用某个工具"的结构化 JSON
        ↓ 被谁执行？
Agent             —— 系统架构层：LLM + 工具 + 循环 + 终止条件 的编排系统
        ↓ 工具/上下文怎么标准化接入？
MCP               —— 协议层：把"工具/资源/提示"以统一协议暴露给任何客户端（JSON-RPC）
        ↓ 知识从哪来？
RAG               —— 知识架构层：先检索外部知识，再塞进上下文让 LLM 生成
        ↓ 流程性经验怎么复用？
Skill             —— 知识封装层：把"某类任务该怎么做"写成 Markdown 说明书，按需加载给 Agent
```

一句话定位（背下来，面试开场就用）：
- **Function Calling**：模型决定"调用什么函数、传什么参数"，但执行永远在你的代码手里。
- **Agent**：把 Function Calling 放进一个循环里——模型调用工具 → 你把结果喂回去 → 直到模型给出最终答案。
- **RAG**：模型的知识不够新/不够私有时，先检索再生成，"开卷考试"。
- **MCP**：工具接入的 USB-C 接口标准——以前每家 Agent 自己定义工具格式，现在写一个 MCP Server 所有客户端都能用。
- **Skill**：不提供新能力，提供"做事的流程知识"——什么时候该查、查完该怎么整理，一段 Markdown 说明文档。

---

## 1. 学习路线总览

顺序是有讲究的：**从原子能力往上搭**，后面每个 demo 都复用前面的代码。

| # | 模块 | 你要亲手写的东西 | 面试考点 | 状态 |
|---|------|----------------|---------|------|
| 0 | 环境准备 | API key + 跑通第一次对话 | — | ☐ |
| 1 | Function Calling | `tool_call.ts`：让模型调用你的天气/计算器函数 | messages 数组结构、tool_calls 字段、为什么要循环 | ☑ |
| 2 | RAG | `rag.ts`：本地文档问答（切片→向量化→检索→生成） | 为什么要切片、chunk 大小、embedding 是什么、和微调的区别 | ☑ |
| 3 | Agent | `mini_agent.ts`：ReAct 循环 + 工具注册表 + 终止条件 | Agent 和工作流的区别、死循环怎么办、多轮上下文管理 | ☑ |
| 4 | MCP | `mcp_server.ts` + 自己接入 ZCode | JSON-RPC、tools/resources/prompts 三类原语、和 function calling 的关系 | ☑ |
| 5 | Skill | 给 ZCode 写一个真实可用的 Skill | Skill vs MCP vs Prompt 的边界、渐进式加载 | ☑ |

每个模块的节奏：**30 分钟读概念 → 1~2 小时写代码（自己写，卡住再问我）→ 对着面试题自测 → 能脱稿讲 2 分钟原理才算过**。

---

## 2. 模块 0：环境准备（今晚就能做完）

技术栈为你量身选的：**Node.js + TypeScript + openai SDK + 手写逻辑，不用 LangChain**。
原因有二：① 面试官问"它底层怎么工作的"，用框架的人答不上来，手写过的人秒答；② 你是前端出身，用熟悉的语言学概念，阻力最小。而且 **MCP 官方 SDK 的参考实现就是 TypeScript 写的**，模块 4 正好打你的主场。
（一个诚实的提醒：AI 工程岗 JD 里 Python 出现率确实更高，但这套计划练的是**原理理解**，语言只是载体——原理懂了，读 Python 伪代码不成问题，面试时说"我用 Node 实现，原理一致"反而是加分的表达。）

1. 用智谱开放平台的 key：到 https://open.bigmodel.cn/usercenter/apikeys 创建（你已买 GLM）。**买的是 Coding Plan 套餐就用 `.../api/coding/paas/v4` 端点，按量充值就用 `.../api/paas/v4`**——代码里已注释说明，跑冒烟测试 401 就切换一下。
2. 在 `ai-agent-lab/` 下建一个 `.env` 文件（不要提交到 git）：
   ```
   GLM_API_KEY=你的key
   ```
3. 安装依赖（package.json 已建好，`"type": "module"`）：
   ```bash
   npm install
   ```
4. 跑通冒烟测试：
   ```bash
   node smoke_test.ts
   ```
   Node 24 支持直接运行 .ts 文件（原生类型剥离，不用配 tsconfig；万一报语法不支持就 `npx tsx smoke_test.ts`）。
   看到模型回话即完成。**换模型只需改 `BASE_URL` 和 `MODEL` 两个常量**（GLM、DeepSeek、Kimi、Qwen 等 OpenAI 兼容接口都行）——你的 DeepSeek 欠费后切到 GLM 正好验证了这一点，这就是"OpenAI 兼容协议"这个事实标准的意义。

---

## 3. 各模块详情

### 模块 1：Function Calling —— 一切的原子能力
- **写什么**：定义 `get_weather(city)`（返回假数据即可，重点是流程）和 `calculate(expr)` 两个工具，让模型自主决定调用哪个，你执行后把结果喂回去。
- **必须搞懂的面试题**：
  - 模型真的"执行"了函数吗？（没有，模型只输出 JSON，执行在你的代码里——这句话面试必考）
  - `messages` 数组是怎么滚动的？assistant 的 `tool_calls`、role=`tool` 的结果消息各长什么样？（亲手 console.log 出来看）
  - 如果模型一次返回多个 tool_calls 怎么办？
  - Function Calling 是训练出来的能力还是提示词技巧？（是模型微调出来的能力，但差的模型可以被提示词"模拟"）
- **验收**：脱稿画出一次完整 tool call 的消息流时序。

### 模块 2：RAG —— 开卷考试
- **写什么**：拿几篇本地 txt/md（比如你自己的笔记），实现：切片 → embedding → 余弦相似度检索（向量数学自己手写，十几行）→ 拼进 prompt → 生成。embedding 先用国内 API（DeepSeek 没有 embedding 接口——这本身是个考点：聊天模型厂商 ≠ embedding 厂商，可用硅基流动的免费 BGE 或智谱 embedding-3），有余力再用 transformers.js 在本地跑 BGE 对比。
- **必须搞懂的面试题**：
  - 为什么要切片？chunk 太大/太小各有什么问题？
  - embedding 到底是什么？（文本→高维向量，语义相近则距离近）
  - RAG 和微调怎么选？（知识更新频率、成本、幻觉控制三个维度）
  - 检索质量差怎么优化？（混合检索 BM25+向量、重排 rerank、query 改写——知道概念+能举一反三即可）
- **验收**：问一个文档里的问题，答对；问一个文档里没有的问题，观察它编不编（引出"引用溯源"话题，面试加分项）。

### 模块 3：Agent —— 把 Function Calling 装进循环
- **写什么**：工具注册表（一个 `registerTool()` 函数自动收集 name/schema/实现三件套）+ while 循环 + 最大步数保护 + system prompt。让 Agent 完成"查天气并决定要不要带伞，再算一下往返打车费"这种多步任务。
- **必须搞懂的面试题**：
  - Agent 和 Workflow 的区别？（Anthropic 的定义：工作流是写死的流程编排，Agent 是模型自主决定下一步——你自己写的循环就是这句话的代码版）
  - 怎么防死循环/跑飞？（max_steps、token 预算、敏感操作要确认）
  - 上下文超长怎么办？（截断、摘要压缩——提一句你听说过 context engineering）
- **验收**：脱稿解释你的循环里每一行为什么存在。

### 模块 4：MCP —— 工具接入的 USB-C
- **写什么**：用官方 TypeScript SDK（`@modelcontextprotocol/sdk`）写一个 MCP Server（暴露"查询本机磁盘占用"之类真实有用的工具），然后**把它接进你正在用的 ZCode**，亲眼看到自己的工具出现在 Agent 里；再手写一个 ~100 行的极简 MCP 客户端（裸 JSON-RPC over stdio），彻底理解协议。
- **必须搞懂的面试题**：
  - MCP 和 Function Calling 什么关系？（MCP Server 的工具最终还是转成 function calling 喂给模型；MCP 解决的是"接入标准化"，不是模型能力）
  - 三类原语：tools / resources / prompts 各是什么？
  - 传输方式：stdio（本地子进程）vs Streamable HTTP（远程）
- **验收**：能在 ZCode 里调用你自己的 MCP 工具并截图，脱稿讲协议握手流程。

### 模块 5：Skill —— 流程知识封装
- **写什么**：给 ZCode 写一个你真正会用的 Skill（比如"周报生成器"：读 git log → 按固定结构整理 → 输出），放进配置里真实使用。
- **必须搞懂的面试题**：
  - Skill 和 MCP 怎么选？（Skill 是"怎么做事的知识"，MCP 是"新增能力"；Skill 本质是按需加载的 Markdown 指令，零代码）
  - 为什么 Skill 要渐进式加载（先看 description 再读全文）？（省上下文 token——正好结合你对成本的敏感度讲，这是你比一般候选人懂的点）
- **验收**：Skill 在 ZCode 里真实触发一次，能讲清它和 MCP/Prompt 的边界。

---

## 4. 和 ZCode 协作的省钱规则

- **自己先写，卡住 15 分钟以上再问**，把报错直接贴给我（比我读整个文件便宜得多）。
- 每个 demo 的 LLM 调用走你的 GLM 套餐（Coding Plan 额度内不额外花钱），**不要用 ZCode 的对话额度跑 demo**。
- 面试题自测时，先脱稿说一遍录音，再让我补充——不要让我直接给答案。
- 让我读代码时用 `文件名:行号` 圈定范围，别让我扫全目录。

## 5. 进度记录

每完成一个模块，把上面表格里的 ☐ 改成 ☑，并在对应模块下加一行"我的一句话总结"（用你自己的话写，这才是面试时说得出来的东西）。

---

> **第二阶段**（深入学习：上下文工程 / 记忆 / 任务调度 / Harness / 多 Agent / 生产工程 / 框架横评，2026-10-11 起）规划见 [PHASE2.md](PHASE2.md)。
