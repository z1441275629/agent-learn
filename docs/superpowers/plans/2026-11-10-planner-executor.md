# 模块16 第二层：planner-executor 进路由（链现有技能）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (Native) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 复杂多步消息（如「复盘今天并写篇博客存进知识库」）自动路由到 planner-executor：规划师拆步骤 → 逐步执行（子 agent / 博客编排）→ 逐步产出，确认门/护栏语义全保留。

**Architecture:** 路由三态（plan/composite/normal，规则零 token 预筛）；规划师 = 小档单发调用出严格 JSON 步骤表（fail-closed，解析失败回落单 agent）；执行器 = 顺序跑步骤——`blog` 步骤委托 runBlogComposite，`agent` 步骤跑 runToolLoop 子 agent（全套工具 + 确认门 + 技能触发自动注入），步骤间通过**仓库产物 + 前序摘要**衔接（不重发全量历史，PITFALLS #56）。

**Tech Stack:** 复用现有：runToolLoop（agent.ts）、runBlogComposite（core/composite.ts）、skills.match（core/skills.ts）、SSE/确认门/账本（server/routes/chat.ts）。零新依赖，零前端改动。

**Spec:** 无独立 spec——本计划承接模块16 总控设计（docs/superpowers/plans/2026-11-10-blog-composite.md 的下一层），需求已在对话中定：先做 planner-executor、首场景链现有技能。

## Global Constraints

- 不跑全量验证金字塔：tsc + 零 token 内联断言即可（用户既定纪律）
- 提交前 PII 扫描（git diff --cached | grep -nE '1[3-9][0-9]{9}|[0-9]{17}[0-9Xx]|赵德升|26435|pk-lf-[a-zA-Z0-9]|sk-lf-[a-zA-Z0-9]'，exit 1 = 干净）；匿名提交；commit 前缀「模块16」
- 确认门语义不动：write 工具全部过 askConfirm；子 agent 只能借门，无旁路
- 不碰用户未提交文件（package*.json / .vscode/ / langChain/ / test-images/ / docs/ 里旧计划）；不动前端
- 空产出机械兜底（#57）、abort 先查 signal（#53）、源头截断（#56）三条教训全部适用

## Review Focus

1. 路由预筛的真实消息覆盖：双动作+连接词才进 plan，防「写一篇关于复盘的博客」误入（有 复盘+博客 两词但无连接词）
2. 规划师 JSON 解析 fail-closed：坏输出回落单 agent，不许崩
3. 步骤间上下文只传摘要（每步 ≤600 字）——防 #56 式全量重发
4. blog 步骤嵌套在 plan 里的 emit/确认卡/usage 合并是否正确
5. 步骤中途 abort 的归因（interrupted 落盘）与成本护栏的诚实停机

---

### Task 1: 路由三态（router.ts 加 plan 模式）

**Files:**
- Modify: `personal-agent/core/router.ts`
- Test: 内联零 token 断言脚本（node 直接跑，不留测试文件）

**Interfaces:**
- Produces: `RouteMode = 'plan' | 'composite' | 'normal'`；`routeMessage(text): RouteMode`

- [ ] **Step 1: 写内联断言脚本（先红后绿）**——断言下表全部通过（当前代码无 'plan' 会直接类型报错/断言失败）：

| 消息 | 期望 |
|---|---|
| 复盘今天并写篇博客存进知识库 | plan |
| 先复盘再写博客 | plan |
| 帮我记笔记并复盘今天 | plan |
| 写一篇关于funciton calling的博客 | composite |
| 写一篇关于复盘的博客 | composite（两动作词但无连接词） |
| 复盘今天 | normal |
| 写博客怎么开始 | normal（问句先拦） |
| 总结一下今天学的东西 | normal |

- [ ] **Step 2: 实现**——`PLAN_CONNECTORS = /(并|然后|再|之后|接着|同时)/`、`PLAN_ACTIONS = /(复盘|日报|博客|技术文章|文章|笔记|知识库|简报|总结)/`（g 标志 matchAll 取**去重命中数**）；判定顺序：问句 → plan（去重动作词 ≥2 且命中连接词，plan 判定在 composite **之前**——「复盘并写博客」两类触发都命中，多步优先）→ composite → normal
- [ ] **Step 3: 跑断言全绿 + tsc（router.ts 零错）**
- [ ] **Step 4: Commit**（模块16 planner·路由三态…）

### Task 2: 规划师（core/planner.ts 新建）

**Files:**
- Create: `personal-agent/core/planner.ts`
- Test: 内联零 token 断言（mock client，不烧 LLM）

**Interfaces:**
- Consumes: `ModelEntry`（models.ts）、`thinkingParams`
- Produces:
  - `interface PlanStep { goal: string; capability: 'blog' | 'agent' }`
  - `parsePlan(raw: string): PlanStep[] | null`——纯函数：剥 ```json 围栏 → JSON.parse → steps 数组校验（goal 非空字符串、capability ∈ {'blog','agent'} 否则归 'agent'）→ 截断到 ≤4 步 → 任何失败返回 null（fail-closed）
  - `planTask(text, opts: {lightEntry, signal?}): Promise<PlanStep[] | null>`——小档单发非流式、thinking off；解析失败/空步骤 → null（调用方回落单 agent）

- [ ] **Step 1: 断言脚本（mock client 返回各坏输出）**——合法 JSON→4 步截断/5 步输入只留 4；坏 JSON→null；capability 未知→'agent'；带围栏→能解；空 steps→null；goal 空→该步剔除后为空则 null
- [ ] **Step 2: 实现** PLANNER_PROMPT（要点：能力清单 blog/agent 各一句；goal 自包含（执行者只看到 原始请求+goal+前序摘要）；有技能场景在 goal 里点名技能名；串行依赖排序；输出只要 JSON）
- [ ] **Step 3: 断言全绿 + tsc**
- [ ] **Step 4: Commit**

### Task 3: 执行器（core/plan.ts 新建）

**Files:**
- Create: `personal-agent/core/plan.ts`
- Test: 内联零 token 断言（mock runToolLoop 假 client）

**Interfaces:**
- Consumes: `PlanStep`/`planTask`（planner.ts）、`runBlogComposite`（composite.ts）、`runToolLoop`+`ToolDef`（agent.ts）、`SkillStore`（skills.ts 的 `match(text)`）、`thinkingParams`
- Produces:
  - `interface PlanRunOptions { entry; lightEntry; allTools: ToolDef[]; readTools: ToolDef[]; skills: SkillStore; emit?; signal? }`
  - `interface PlanRunResult { stoppedBy: 'done' | 'cost-guard' | 'aborted' | 'error'; finalText: string; trace: CompositeRoleTrace[]; promptTokens; completionTokens; steps: { goal; capability; deliverable }[] }`
  - `runPlan(text: string, steps: PlanStep[], opts): Promise<PlanRunResult>`——步骤已由调用方解析好（失败回落在 chat 层做）

- [ ] **Step 1: 实现** runPlan：
  - RunCtx 复用 composite 的模式（trace/prompt/completion/emit）；`CEILING = PA_PLAN_TOKEN_CEILING ?? 100000`
  - 每步开工前查 overBudget/aborted（诚实停机：报告已完成步骤的交付物）
  - `agent` 步骤：runToolLoop 子 agent——system = 步骤执行提示 + `await opts.skills.match(step.goal)` 命中的技能全文注入（chat-service 同款 preloadedBlock 格式）；user = 原始请求 + 本步 goal + 前序各步摘要（deliverable 前 600 字）；工具全套 allTools（write 过门由 chat 层 onConfirm 接线）；maxRounds 5 / maxCalls 8 / maxResultChars 3000；deliverable = `res.lastText || res.text`，仍空给机械兜底句（#57）
  - `blog` 步骤：`runBlogComposite(step.goal, { entry, lightEntry, readTools, signal, emit: tr => addTrace(`博客步骤｜${tr.name}`,…) })`；usage 并入 ctx；stoppedBy 非 done 时按其 finalBlog 记该步交付物并停链
  - catch 先查 signal.aborted（#53）；finalText = 各步交付物拼接（标题行 + 摘要），stoppedBy 决定收尾语
  - trace 芯片名：`规划师`（在 chat 层出）之外本层出 `执行#N｜blog` / `执行#N｜agent`
- [ ] **Step 2: 零 token 断言**（mock：blog 步骤 fake runBlogComposite？——不 mock 模块，改为只测纯组装逻辑：步骤摘要拼接上限、成本护栏触发即停、aborted 短路；LLM 调用路径靠 tsc + 代码审查）
- [ ] **Step 3: tsc + Commit**

### Task 4: chat 路由接线（server/routes/chat.ts）

**Files:**
- Modify: `personal-agent/server/routes/chat.ts`

**Interfaces:**
- Consumes: `routeMessage` 三态、`planTask`、`runPlan`、state 的 skills 注册表

- [ ] **Step 1: 接线**——`const mode = toolsOn ? routeMessage(text) : 'normal'`；plan 分支：`const steps = await planTask(text, { lightEntry, signal: ac.signal })`，null → 落 normal 分支（复用现有 else 代码，不复制）；有效 → `runPlan(text, steps, { entry, lightEntry, allTools: tools, readTools, skills, signal, emit: 同 composite 的 tool 帧映射 })`；出 `规划师` 芯片（args=消息摘要，result=步骤表一行一步）；done 帧落账本 + runMemoryExtraction；aborted → interrupted 落盘（同 composite 分支语义）；确认卡复用 askConfirm（子 agent 的 write 过门）
- [ ] **Step 2: tsc（chat.ts 零错）+ 自查清单**（确认门无旁路 / plan 失败回落单 agent / usage 合并 / aborted 归因）
- [ ] **Step 3: Commit + 收尾**（PITFALLS 若有新坑自动收录）
