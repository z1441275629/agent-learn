# 模块 10 · 多 Agent——上下文隔离与并行的兑换率

> 写法提醒：同 06~09——自己的话、数字说话、每节先自问自答。
> 本模块的特殊性：**每一节都在为「值不值」记账**——多 agent 的收益（隔离+并行）和代价（token ×N）必须成对出现，光把模式写出来不算完成。

## 0. 定位：多 Agent 买的是什么

- 本质收益 = **上下文隔离 + 并行**（不是「更聪明」）：子 agent 在干净窗口里干活、只回传结论，主管的窗口不被过程污染
- 代价：token 成本 ×N 以上（Anthropic 研究系统的真实数据：约 15×）
- 决策清单（本节产出）：什么时候单 agent + 工具就够？——从任务可拆性、上下文污染程度、并行度、预算四个轴给自己的判断规则
- 资产复用地图：09 的 createAgent（天生干净上下文）、agentLoop、dispatch 咽喉（权限/hook 白送）、persist（子 agent 会话隔离落盘）——**模块 10 不新建底座，搭在 09 肩膀上**

## 1. 底座：spawn 原语

- `spawn(task, opts) → { conclusion, tokens }`：起一个子 agent、给它任务书、拿回结论——五种编排模式的共同原子
- 关键设计：传进子 agent 的上下文边界（任务书 + 必要交接物，**不是整本账**）；失败传播（子 agent 死了/超时了，主管收到什么）
- 引导问题：子 agent 回传「结论」还是「过程」？谁决定？（提示：主管窗口的洁净度就是这个决定的直接后果）

## 2. 模式一：supervisor（主管分派）

- 主管不干活，只拆活、派活、收活；对照 08 planner 的血缘（planner 一次出图，supervisor 循环派单——差别在哪？）
- 引导问题：supervisor 的上下文里该常驻什么？（子 agent 结论的**摘要**——不是全文，否则隔离白做）

## 3. 模式二：pipeline（流水线）

- A 的产出是 B 的输入，线性传递；血缘：08 planner 的 dependsOn 步间转交就是它
- 引导问题：段与段的「接口契约」怎么定？上游产出不合格，下游是硬吃还是打回？

## 4. 模式三：parallel fan-out/fan-in（并行扇出汇总）

- 同一任务派 N 个子 agent 并行跑，fan-in 汇总——map-reduce 的 agent 版；血缘：08 的 Promise.all 批量执行 + Anthropic 的 orchestrator-worker
- 引导问题：fan-in 合并策略（拼接 / 投票 / 再起一个 agent 归纳）？最慢的决定墙钟——要不要超时弃子？

## 5. 模式四：handoff（交接）

- 会话控制权从 A 转给 B（用户接着和 B 聊，A 退场）；对照：ZCode/Claude Code 的 subagent 转交
- 引导问题：交接时传什么（A 的结论摘要？用户原始诉求？）——不传什么同样重要

## 6. 模式五：generator-critic（生成-评审）

- 生成者出稿、评审者打回、循环直到通过或熔断——**带否决权的 pipeline**
- 引导问题：critic 的评审标准怎么写才不是玄学（checklist 化）？打回循环熔断几次？

## 7. 组合系统：研究员 → 写手 → 审校

- pipeline（研究→写作）× generator-critic（写作⇄审校打回）的组合拳，产出周报或调研报告
- 工具层复用旧资产：研究员配 02 RAG / 07 记忆检索
- 失败传播全链路：研究员空手而归时，写手该收到什么？（空手 ≠ 消息丢失）

## 8. 验收一：上下文流转图

- 画一次真实运行：每个 agent 窗口里**有什么**（system / 任务书 / 上游交接物）、**传出去什么**（结论 / 全文 / 摘要）
- 用运行日志实测填充，不是概念图

## 9. 验收二：token 账本

- 一次完整运行的逐 agent 账单：prompt / completion、×N 实测倍率、与单 agent 方案对比
- 数据槽：单 agent 基线 ___ tokens；三 agent 系统 ___ tokens（×___）；并行省墙钟 ___ s

## 10. 框架对照 + 一句话总结

- LangGraph.js 的 supervisor 实现；CrewAI / AutoGen 概念（Python 阅读级）
- 「我手写的 X = 框架里的 Y」对照表补多 agent 行
- 一句话总结（必填，用你自己的话）

## 附：本模块踩的坑

见仓库根 [PITFALLS.md](../PITFALLS.md) 的 [10] 标签条目。
参考文章 [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)