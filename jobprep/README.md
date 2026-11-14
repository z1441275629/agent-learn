# jobprep · AI 面试备战台

> LangChain/LangGraph 实践线的毕业项目（S9）。一个 Web 入口，三个专业 agent，把「学习复盘攒下的弹药」变成每天真用的备考工具。
> 定位：面试作品集 + 入职后长期维护的正经工程。

## 它解决什么

备考 AI 应用/Agent 开发岗位的人，手里都有这些东西：复盘笔记（含面试题和参考答案）、踩坑记录、机制对照表——但它们只是「躺着」。jobprep 把它们变成：

- **陪练**（已上线）：每场 5 题，从你的真实题库抽题（可溯源），暂停等你口述作答，AI 判官锚定参考答案批改（命中/遗漏要点），错题自动进轮换重出，场末出弱点小结
- **简历**（P2）：上传旧简历做「前端 → AI 应用」重定位改写（diff 预览 + 审批落盘），或从零引导生成；全程本地处理
- **培训**（P3）：同一题库换讲解模式——讲给你听 + 单题即测

## 架构

```
浏览器（三页签单文件前端，SSE 消费）
   │  POST /api/practice {sessionId, text?}      ← 无 text=开新场/重连补发；有 text=作答 resume
   ▼
SSE 桥（server.ts，帧协议 delta 系列中的 custom/question/done）
   ▼
陪练图（StateGraph + checkpointer，thread = practice:{sessionId}）
   START → start_session → pick_question → ask[interrupt 等人] → grade[判官·温度0·锚定参考答案]
           ▲                                              │
           └──── round < N ←──────────────────────────────┤ round ≥ N → summarize → END
```

- **题库**（`src/bank/loader.ts`）：装载仓库根 `reviews/*.md` 的 §3 面试题与 §4 参考答案（序号配对）+ `PITFALLS.md` 症状条目转排障题。每题带 source 元数据，判官引用它——**批改可溯源，防判官幻觉**
- **持久化**：SqliteSaver（`data/jobprep.db`，gitignore）。会话身份 = thread_id；同一 sessionId 跨场延续错题轮换历史（断线/关页后可重连续答）
- **流式**：SSE 帧协议 `custom / question / done`（LangGraph custom 通道，`getWriter()` 写入）

## 快速开始

```bash
cd jobprep
npm install
# 配置：jobprep/.env 或直接用仓库根 ../.env（LLM_MODEL / LLM_API_KEY / LLM_BASE_URL）
npm run dev          # → http://localhost:8790（JOBPREP_PORT 可覆盖）
```

要求 Node ≥ 24（直接跑 TS，type stripping）。

## 测试

```bash
npm test             # vitest：题库解析 / 抽题策略 / 图拓扑循环（全部零 LLM token，判官注入 fake）
npm run typecheck    # tsc --noEmit
```

## 三个工程决定（面试讲法）

1. **入口用显式页签直选，不做 LLM triage**——入口是路由失败零容忍的地方，UI 确定性选择优于语义判定；LLM 判定留给真正需要模糊分流的场景。
2. **判官锚定参考答案，且必须引用题库 source**——评分是「要点比对」不是「知识发挥」；可溯源是批改质量的底线（题面、参考答案、批改三者可回查）。
3. **不用 deepagents，用 StateGraph 手写图**——三个功能都是强流程（出题循环/审批门/文档流），拓扑确定性 > harness 探索灵活性；deepagents 适合开放探索型任务。抽题不走向量：题库百级全量在内存，**均匀轮换与错题优先才是真需求**，检索是伪需求。

## 数据与隐私

- 运行数据（sqlite）与简历文件都在 `jobprep/data/`（gitignore），全程本地
- 简历链路不上传 LangSmith（P2 实现时局部关 tracing）；其余链路 LangSmith tracing 默认跟随环境变量

## Roadmap

- P2 简历：上传（md/txt 起步，pdf/docx 评估后加）→ 分析 → diff 预览 → interrupt 审批 → 落盘
- P3 培训：讲解模式（复用陪练的题库与判官零件，不复用图）
- V2 候选：判官质量 LangSmith eval / 抽题主题加权与相似去重（届时引入嵌入）/ stop/skip 作答指令 / 跨场弱点趋势（Store）/ 前端 Vue 化 / `langgraph dev` 兼容部署

## 设计文档

`../docs/superpowers/specs/2026-11-14-jobprep-design.md`（含用户拍板项与构建侧决定的完整清单）
