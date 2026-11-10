# personal-agent 评估报告

- 模型:`deepseek-v4-flash`(主档,thinking off)· 运行:2026-11-10T12:21:30.489Z
- 范围:单 agent 主路径(工具循环 + 记忆注入 + KB 引导 + 技能自动加载),确认门自动批准;编排(composite/planner)不在本版范围
- 注意:真实模型单次运行,结果受随机性影响;判分标准见 `tasks.json`,复跑对比看 `results.json`

## 总指标

| 指标 | 值 |
| --- | --- |
| 任务成功率 | **20/20(100%)** |
| 工具调用成功率 | 26/26(100%) |
| invalid-call 率 | 0.0%(模型调错工具/坏参数) |
| 执行失败数 | 0 |
| 延迟 | 均值 4.5s / 中位 4.1s / P95 10.0s |
| token 成本 | 共 219996(prompt 214832 + completion 5164),均值 11000/任务 |

## 分类明细

| 类别 | 通过 | 任务 |
| --- | --- | --- |
| time | 2/2 | ✓time-01 ✓time-02 |
| knowledge-base | 4/4 | ✓kb-01 ✓kb-02 ✓kb-03 ✓kb-04 |
| write-tool | 4/4 | ✓write-01 ✓write-02 ✓write-03 ✓write-04 |
| browser | 3/3 | ✓browser-01 ✓browser-02 ✓browser-03 |
| repo | 2/2 | ✓repo-01 ✓repo-02 |
| chat | 2/2 | ✓chat-01 ✓chat-02 |
| skill | 1/1 | ✓skill-01 |
| combo | 2/2 | ✓combo-01 ✓combo-02 |

## 未通过任务

(无)