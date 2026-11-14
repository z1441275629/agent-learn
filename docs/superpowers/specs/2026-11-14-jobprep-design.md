# S9 毕业项目设计：AI 面试备战台（jobprep）

> 2026-11-14。LangChain 实践线 S9（OUTLINE §3），方向 B（独立日用 agent）。
> 选题、v1 范围、入口形态、内容地基均为用户拍板；标注【我的决定】的是构建侧取舍，用户可推翻。

## 1. 意图与为什么

用户正在找 **AI 应用/Agent 开发**岗位，同时在这条线上每天产出学习复盘（reviews/ 含面试题+参考答案）、坑库（PITFALLS.md）、对照表。这些弹药现在只是「躺着」——本项目把它们变成每天真用的备考工具：

**一个 Web 入口，三个专业 agent**：
- **陪练**：每天从题库抽题考用户（HITL 作答）→ 批改 → 错题轮换 → 弱点可见
- **培训**：同一知识源换讲解模式（讲给用户听 + 一题即测）
- **简历**：通用文档流——有旧简历则上传后做「前端→AI 应用」重定位改写；无则引导生成

为什么值得做：它把 S1~S8 全部实证件组装进一个产品（多 agent 调度、HITL、checkpointer、RAG 题库、流式前端、LangSmith），且备考是用户当下的真实日频需求——「每天真用一次」不是假设。

## 2. 目标 / 非目标 / 反目标

**目标（v1，2 周 ≈ 10~16h）**
- 统一 Web 入口：一个页面三个功能，SSE 流式（token/工具/事件帧，S8 底盘已验证）
- 陪练 agent 完整闭环：抽题→作答（暂停等人）→批改（对照参考答案）→记录→错题轮换
- 培训 agent：陪练图换讲解模式（复用底盘）
- 简历 agent：上传（可选）→ 分析/引导 → 改写提案（diff 预览）→ 审批落盘
- 工程正规：README、类型零错、基本图测试（mock LLM 的拓扑测试）、LangSmith tracing 已接

**非目标（v1 不做，记入 README Roadmap）**
- 微信双向入口、岗位监控/晨报类信息 agent、多用户/鉴权、云部署、移动端适配
- LangSmith 批改质量 eval dataset（V2；v1 批改带参考答案锚定即可）

**反目标（做了就算失败）**
- 为了「平台感」过度抽象：任何 agent 不依赖脊柱就能独立跑通才算做对
- 题库内容外包给模型编造：题目必须可溯源到 reviews/PITFALLS 的原文（溯源标记进元数据）

## 3. 约束

- **项目形态（2026-11-14 用户升级要求）**：正规工程，独立顶层目录 `jobprep/`（与 personal-agent/ 同级），**独立 npm 包**（自己的 package.json/tsconfig/node_modules）、可编译（tsc）、有测试框架（vitest）、README 按 README 标准（架构/运行/测试/Roadmap）——目标：**面试作品集 + 入职后长期维护**，不是随手的练习件。构建由 AI 主导生成，不再逐项询问（用户明确授权），构建侧取舍由 AI 定并在代码/README 标注
- 语言/运行时：TS + Node 24；模型方舟 GLM（env 三件套，`.env` 读取链：`jobprep/.env` 优先、回落仓库根 `../.env`——密钥保持单一来源）
- 预算：v1 两周一稿——**任何阶段停下都必须留下一个能跑的增量**（建设顺序保证）
- PII：简历文件本地处理，uploads 与产物目录 gitignore，简历链路不上传 LangSmith
- 测试纪律：vitest 单测覆盖图拓扑逻辑（mock LLM 的路由/轮换/审批门），不跑全量金字塔

## 4. 用户已拍板的决定

1. 方向 B（独立日用 agent），非 A（重写博客编排）
2. v1 三件套：**简历 + 面试培训 + 陪练**（按面试临近的紧迫度，不是我以为的最小集）
3. 统一入口 = **自建 Web**（S8 SSE 桥升级；不选 CLI/官方 Agent Chat UI/微信）
4. 目标岗位主线 = **AI 应用/Agent 开发**（题库与现有弹药库完全重叠）
5. 简历功能做成**通用件**：区分「有简历（上传改写）/无简历（引导生成）」两条路

## 5. 架构与构建侧决定

### 5.1 目录与形态【我的决定】

```
jobprep/                     # 顶层独立包（与 personal-agent/ 同级）
  package.json               # 独立依赖：langchain / @langchain/langgraph / -sqlite / openai / zod / dotenv
  tsconfig.json              # strict，NodeNext，build→dist
  vitest.config.ts           # 图拓扑测试（mock LLM）
  .env.example  .gitignore   # data/（sqlite+uploads）与 .env 不进库
  README.md                  # 架构图 + 工程决定 + 运行/测试 + Roadmap
  src/
    env.ts                   # env 读取链（本地 .env → 根 ../.env）
    server.ts                # HTTP + SSE 桥（S8 帧协议升级）
    bank/loader.ts           # 题库装载（reviews §3/§4 配对 + PITFALLS 排障题）
    agents/practice.ts       # 陪练图（核心件）
    agents/train.ts          # 培训（P2）
    agents/resume.ts         # 简历（P3）
    web/index.html           # 三页签单文件前端
  data/                      # 运行数据（gitignore）
```

前端不引框架（v1 单文件够用，Vue 化是 Roadmap 项）。

### 5.2 入口路由：显式页签直选，不做 LLM triage【我的决定·2026-11-14 修订】

三个功能页签 = 三个确定性入口，用户点哪个进哪个 agent。**入口是路由失败零容忍的地方，用 UI 显式选择而不是 LLM 语义判定**——LLM triage 留给需要模糊分流的场景（本项目没有）。面试讲法照旧成立（这反而是更硬的工程决定）：控制面按真实交互模式选型，机制不堆。

### 5.3 陪练 agent（核心件）

StateGraph：`pick_question → ask(interrupt) → grade → record → loop|finish`
- **题库**：loader 解析 reviews 的 §3 题目 + §4 答案（按序号配对），PITFALLS 条目转「场景排障题」（症状即题面，修法即答案）。每题元数据带 source 文件+条目号（可溯源，反目标保障）
- **抽题**：v1 纯内存策略——错题优先重出（间隔 >1 轮）+ 未做题均匀轮换，**不走向量也不上 BM25**（题库百级且全量在内存，检索是伪需求，均匀性与错题轮换才是真需求；中文 BM25 还得分词，见 S7 实证）。主题加权进 Roadmap
- **作答**：`interrupt()` 等用户输入（S5 已验：responseSchema 校验、暂停点无损）；跨进程 resume（Web 会话断线重连可续答）
- **批改**：LLM 判官（温度 0）+ 参考答案锚定 + 评分维度（要点命中/遗漏/表达）；判官 prompt 要求引用题库 source——**批改必须可溯源，防判官幻觉**
- **记录与轮换**：SqliteSaver（答题历史随 thread）；错题轮换 = state channel 记 `wrongIds`，下次抽题优先重出（间隔 >1 轮）
- **弱点报告**：按题库 source 分组统计正确率（reviews 站点维度/PITFALLS 维度），前端一屏可见

### 5.4 简历 agent

- **上传路**：Web 文件上传（md/docx/pdf→文本抽取，pdf/docx 解析依赖后补）→ 分析（目标岗位 = AI 应用：技能重映射、项目重述角度、关键词覆盖）→ **改写提案以 diff 形式展示**（不直接覆盖原文件）→ `interrupt()` 审批 → 落新文件（原件不动）
- **生成路**：无上传时对话引导（岗位/经历/项目/亮点四段式）→ 生成初稿 → 同样的审批流
- **PII 纪律**：uploads/ 与产物目录 gitignore；简历 agent 的 LLM 调用关闭 LangSmith 上传（`tracing: false` 局部开关）或对内容脱敏——**取舍在实现期定，原则是简历原文不出本机**（LangSmith tracing 传内容，这条必须守住）

### 5.5 培训 agent（陪练的影子件）

同一题库 + 讲解模式：`pick_topic → explain(流式) → quiz(单题即测) → next`。与陪练共享 bank/loader 和批改件，图是独立轻图（不硬塞成一张图的两个模式——复用零件而不是复用图，**面试讲的第二个工程决定**）。

### 5.6 Web 与流式【我的决定】

S8 的 SSE 桥 + 帧协议原样升级：`delta/tool/custom/done` 四帧；`custom` 通道跑批改进度/轮换通知（getWriter() 姿势，#76）。前端单文件三页签，`fetch + ReadableStream` 切帧（S8 已验）。会话：浏览器 localStorage 存 thread_id，断线重连续答题（checkpointer 兜底）。

### 5.7 建设顺序（每步留下能跑的增量；builder check 后 2026-11-14 修订：简历提前到 P2）

| 阶段 | 内容 | 停下时的可用态 |
|---|---|---|
| P0 脊柱 | server + SSE 桥 + 三 agent 桩 + 前端骨架 | 入口能开、帧能流 |
| P1 陪练 | 题库 loader + 陪练图全闭环 | 核心体验完整（可日常用） |
| P2 简历 | 上传/引导 + diff 审批流 | 最紧迫的交付物可用 |
| P3 培训 | 讲解模式（复用陪练零件） | 三件套齐 |
| P4 收口 | README + 拓扑测试 + 弱点报告打磨 | 作品集可展示 |

顺序理由：陪练最快到日用价值且铺好 interrupt/checkpointer/题库底盘（简历的审批流直接复用）；简历是面试前最紧迫的**交付物**；培训最不紧迫（日常学习仪式已覆盖其一半价值）。

### 5.8 builder check 落定（AI 主导生成授权下的构建侧拍板，2026-11-14）

- **会话路由**：每功能独立 thread 命名空间（`practice:{sessionId}` / `train:{…}` / `resume:{…}`），页签=确定性入口，答案经 `/api/practice` 直达 resume——不存在「切功能丢弃挂起点」的交叉（triage 已在 §5.2 移除）
- **deepagents 有意不出场**：三个功能都是强流程（出题循环/审批门/文档流），StateGraph 的拓扑确定性 > harness 的探索灵活性；deepagents 适合开放探索任务。README 工程决定第三条
- **嵌入移出 v1 约束**（原 §3 残留条款）：全设计无消费者；培训主题检索/题目相似去重留 Roadmap
- **陪练终局**：固定 N 题（默认 5）+ 前端随时开新会话；responseSchema 保持裸答案串，stop/skip 枚举留 V2
- **答题账本**：thread state（checkpointer）即账本，弱点报告从当前 thread 累计；不另立 sqlite 表（YAGNI，日频量级可接受）
- **测试清单措辞**：v1 无熔断节点（陪练不打回重写）——拓扑测试覆盖路由条件边/抽题轮换/审批门（P2）



## 6. 验收

- [ ] Web 入口三页签可用，SSE 流式（token + 事件）真机可见
- [ ] 陪练闭环：抽题（可溯源）→ 暂停作答 → 批改（锚定参考答案）→ 错题轮换 → 弱点统计
- [ ] 培训：讲解 + 单题即测
- [ ] 简历：上传路（diff + 审批）与生成路（引导）至少一条完整跑通
- [ ] README：架构图、三个工程决定、Roadmap（非目标列表）
- [ ] 基本测试：mock LLM 的路由/轮换/审批门拓扑测试通过
- [ ] 用户实测「面试前真用了它备战」

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| 2 周装不下三件套 | 建设顺序保证 P1 即最小可用；P2 便宜（复用件）；P3 可砍到单路 |
| 批改质量不稳定 | 参考答案锚定 + 引用溯源要求 + 判官温度 0；V2 上 LangSmith eval |
| 简历 PII 泄漏 | 本地目录 gitignore + 简历 agent 关 tracing（实现期定局部开关方案） |
| 题库面窄（全是 agent 工程） | 与目标岗位完全重叠，是特性不是缺陷；README 注明扩展点 |
| pdf/docx 解析引新依赖 | P3 前评估；必要时 v1 只收 md/txt（用户手头是前端旧简历，md 可转） |

## 8. 待实现期再定的小事（不阻塞设计）

- 培训的「课程线」是否按 OUTLINE 站点顺序组织（S1~S8 时间线即课程线，天然成立）
- 弱点报告的展现（前端图表 vs 文本表）
- 简历 diff 的算法级呈现（行 diff vs 段落重述）
