# S6 验收：pa 机制 ↔ LangChain/deepagents 官方机制对照表

> 定位（面试讲法）：我先在 personal-agent 手写了全部机制，学 S6 时才发现官方标准长这样——
> 同构不是巧合，是「LLM 应用该有什么机制」的设计必然性被官方标准收敛验证了。
> 顶级素材的讲法：**「我手写实现后才发现官方标准长这样，验证了机制设计的必然性。」**

## 总表

| # | 机制 | pa 手写（personal-agent/） | 官方（LangChain JS / deepagents@1.16） | 同构度 | 关键差异 |
|---|------|---------------------------|----------------------------------------|--------|----------|
| 1 | 技能加载 | [core/skills.ts](../personal-agent/core/skills.ts)：SKILL.md frontmatter（name/description/triggers）索引 + 命中后按需加载全文 + 伴生文件（skills/learning-review/SKILL.md + questions-guide.md） | createSkillsMiddleware：SKILL.md frontmatter（name/description）+ 按需加载正文，skills:['/skills/'] 注册 | ★★★ 几乎逐条同构 | pa 多 triggers 字段（中文自然问法）；deepagents 有大小上限（MAX_SKILL_FILE_SIZE）+ 同名 last-wins 覆盖 |
| 2 | 子代理/编排 | [core/composite.ts](../personal-agent/core/composite.ts)：研究员/审校/写手显式代码编排，双修订回边（审校打回）| 三种：S3 StateGraph 条件边/Send（代码编排）；deepagents task 工具（模型自主派活，isolated 上下文）| ★★ 概念同构、控制面不同 | pa 跳转=代码决定（确定性）；task 派活=模型决定（灵活但不确定）——同一频谱的两端 |
| 3 | HITL 审批 | 确认门 fail-closed：无门/抛错/超时/断流一律拒绝（09 课以来的原则，全在代码层） | humanInTheLoopMiddleware / 图内 interrupt() / deepagents interruptOn + Command resume | ★★ 机制同构 | 框架只给「暂停点+resume 通道」，放行策略是空的：无超时、无兜底拒绝、空线程 resume 静默空转（PITFALLS #71 实证）——fail-closed 得接入方自己补 |
| 4 | 记忆 | [core/memories.ts](../personal-agent/core/memories.ts) 落盘 + 注入 prompt | 三层：thread state（隔离）/ Store（跨 thread）/ deepagents AGENTS.md（启动并入 system prompt）；wrapModelCall 注入=请求副本不污染会话 | ★★ 注入思想同构 | 框架分层更细；pa 一层扁平——「注入不落会话历史」两边一致（S4 实证） |
| 5 | 快照/恢复 | [core/sessions.ts](../personal-agent/core/sessions.ts) 业务层账本：轮级、按需、审计回看用 | checkpointer 执行层快照：每 superstep、全量 channels、恢复/重放/分叉用 | ★ 同构思想不同粒度 | S4 结论：一个是业务层（审计），一个是执行层（时间旅行）——用途决定粒度，不是替代关系 |
| 6 | 判定节点参数 | [models.ts](../personal-agent/models.ts) thinkingParams() 按判断类型配思考档 | routerLlm/judgeLlm：温度 0 + 思考档，经 modelKwargs 直通（PITFALLS #67） | ★★★ 同款坑同款修法 | 两边结论一致：产出节点放开参数、判定节点锁死——图拓扑的确定性止于第一个未锁参数的判定节点 |
| 7 | 护栏 | composite：修订熔断 ≤2 轮 + 成本护栏 + maxCalls 机械闸 | deepagents 无内置任何护栏 | ✗ pa 有、框架无 | 「框架管编排，护栏得自己加」——deepagents 要在 middleware 层自己补（S6 头注原文，OUTLINE 原话） |
| 8 | 交棒协议 | 无（单 agent） | handoff：goto + update 必须成对，ToolMessage 写给接手方（PITFALLS #72） | — 新增机制 | 教训泛化：跨 agent 传递的每条消息都要问「下读到它的人是谁」 |
| 9 | 沙箱 | 无沙箱概念，靠确认门兜副作用 | FilesystemBackend rootDir ≠ 沙箱（virtualMode 默认 false 绝对路径放行，PITFALLS #73） | ★ 安全默认都需接入方补 | 两家一样：安全语义查源码，不查参数名字 |
| 10 | 多轮收口 | chat.ts 流式直通用户 | handoff 无收口人（最后一条≠最终答案）；subagents/supervisor 主 agent 收口（S6 实证） | ★ 问题同源 | 控制权转移的代价=没人有全局视野——生产 handoff 都走流式全量回放 |

## 详解①：技能加载同构（顶级素材行）

pa 手写的 SKILL.md（先写）：

```yaml
---
name: learning-review
description: Use when 用户要写每日学习复盘/日报……是用户个人的每日学习复盘仪式，不是回答技术问题。
triggers: 复盘,写日报,总结今天学了啥,……
---
```

deepagents 官方标准（后见）：同样 frontmatter name/description 索引 + 命中才加载正文（省 token）+ 伴生文件随技能目录走。
同构的三层结构：**索引常驻（description 进 system prompt）→ 触发判断 → 正文按需（临时进上下文）**。

面试讲法：「我按『省 token 的两层加载』设计了 skills.ts，几个月后看到 Agent Skills 标准，frontmatter 索引+按需加载全文逐条对上——说明这个机制是 token 经济学下的必然设计，不是某个库的私货。」

## 详解②：框架没给你的护栏清单（pa 有 / deepagents 无）

| 护栏 | pa 实现 | 为什么框架不给 |
|------|---------|----------------|
| 修订熔断（≤2 轮） | composite 计数 + 两态分离（研究段熔断=终止出失败报告；写手段熔断=降级交付最后一稿） | 熔断阈值是业务决策，框架无法预置 |
| 成本护栏 | 逐调用计量 + 预算闸 | 同上——预算多少只有接入方知道 |
| maxCalls 机械闸 | 独立于模型意志的计数闸 | 框架的 recursionLimit 是兜底不是业务闸 |
| 审批超时/兜底拒绝 | fail-closed：异常一律拒绝 | 框架 resume 通道不验挂起点存在性（#71） |

一句话收束：**框架管编排（怎么串起来），护栏管底线（出事怎么办）——后者永远是接入方的活。**

## 验收对照（OUTLINE 原文）

- [x] 一个 deep agent 带 2 个自定义 subagent（researcher/critic）+ 1 个 skill（gpu-triage）跑通 —— 2026-11-13，d5c3c06
- [x] 「pa 机制 ↔ 官方机制」对照表 —— 本文件
