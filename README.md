# AI Agent 实验室

从零手写 Agent 全链路：不依赖框架，从 Function Calling 的消息流一路写到每天都在用的个人 Agent 工作台。TypeScript 单语言，纪律是「先手写理解原理，再用框架对照验证」。

## 亮点

- **手写 ReAct Agent**：工具注册表 + 循环 + 终止闸 + token 预算，不用任何框架 → [03-agent/](03-agent/)
- **MCP 双向实践**：官方 SDK 写 Server 接进日常使用的 coding agent；再手写 ~100 行裸 JSON-RPC over stdio 客户端拆透协议 → [04-mcp/](04-mcp/)、[personal-agent/mcp-server.ts](personal-agent/mcp-server.ts)
- **零 token 测试金字塔**：单测层不发起任何 LLM 调用——vitest 8 用例（[jobprep/tests/](jobprep/tests/)）+ node:test 28 用例（[10-multi-agent/](10-multi-agent/)）+ 回归用例集（[tests/regression/](tests/regression/)）
- **面试题库 99 题（必背 62）**：9 章，每题背诵要点 + 追问链，答案落到本仓库的真实证据 → [docs/interview/](docs/interview/)
- **踩坑实录 65 条**：症状 → 根因 → 修法 → 原则，全部亲手踩过 → [PITFALLS.md](PITFALLS.md)
- **个人 Agent 工作台（在用）**：shot2text 截图取字——本地 tesseract OCR + LLM 翻译，端到端约 3 秒，零 token 探针 15/15 → [personal-agent/](personal-agent/)

## 三阶段路线

| 阶段 | 主题 | 模块 | 状态 |
|---|---|---|---|
| [一](PHASE1.md) | 手写原子能力：Function Calling / RAG / Agent / MCP / Skill | 01~05 | ✅ |
| [二](PHASE2.md) | 工程化：上下文 / 记忆 / 规划 / Harness / 多 Agent / 生产工程 / 框架横评 | 06~12 | ✅ |
| [三](PHASE3.md) | 实用能力：多模态 / Computer Use（宿主 personal-agent/） | 13~16 | 🚧 |

## 并行线

- [langChain/](langChain/)：LangChain/LangGraph 实践线——手写机制逐站对照框架实现，S0~S10 大纲、S1~S8 已落地
- [jobprep/](jobprep/)：毕业项目「AI 面试备战台」——陪练已上线（真实题库抽题、AI 判官锚定批改、错题进轮换），简历 / 培训规划中
- [blogs/](blogs/)：4 篇深度复盘——Planner-Executor 落地、多 Agent 记忆、自动编排层、RAG 本质
- [reviews/](reviews/)：学习日报与面试速查

## 目录地图

| 目录 | 内容 |
|---|---|
| [01-function-calling/](01-function-calling/) | tool_calls 消息流：模型决定调用，代码负责执行 |
| [02-rag/](02-rag/) | 切片 → embedding → 余弦检索 → 生成，向量数学手写 |
| [03-agent/](03-agent/) | 手写 ReAct 循环：工具注册表 + 终止闸 + token 预算 |
| [04-mcp/](04-mcp/) | MCP Server + ~100 行裸 JSON-RPC over stdio 客户端 |
| [05-skill/](05-skill/) | Skill 实践：流程知识封装为按需加载的说明书 |
| [06-context/](06-context/) | 上下文工程：测量 / 滑动窗口 / 截断 / compaction |
| [07-memory/](07-memory/) | 文件型 + 检索型双通道记忆，混合检索 |
| [08-planner/](08-planner/) | planner-executor + 并发子任务 |
| [09-harness/](09-harness/) | Agent 加壳：权限 / 沙箱 / hooks / resume |
| [10-multi-agent/](10-multi-agent/) | 五种编排模式 + 3-agent 协作系统 |
| [11-production/](11-production/) | evals / Langfuse tracing / 注入攻防 |
| [12-capstone/](12-capstone/) | 框架横评（手写 pa ↔ ai-sdk ↔ LangGraph）+ 毕业应用 |

## 关键文档

- [LLM_FUNDAMENTALS.md](LLM_FUNDAMENTALS.md)：LLM 底层原理系统笔记，从零讲起
- [AI_GLOSSARY.md](AI_GLOSSARY.md)：术语表
- [INTERVIEW_QA.md](INTERVIEW_QA.md)：面试高频题参考答案——底层原理 + 深挖追问篇
- [PITFALLS.md](PITFALLS.md)：踩坑实录，跨模块累积
- [PHASE1.md](PHASE1.md) / [PHASE2.md](PHASE2.md) / [PHASE3.md](PHASE3.md)：三阶段学习计划与进度
