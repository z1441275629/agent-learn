// 模块 12 §2：LangGraph.js 重写模块 8 的 planner-executor——同一调度逻辑，图形态
//
// 对照总表（手写 planner.ts → LangGraph.js）：
//   executePlan 的 while(true) 循环   = 图本身（条件边循环回边）——循环变成拓扑
//   plan / stepResults / replans 变量 = State channels（每个字段一个 Annotation）
//   「plan = await replan(...) 赋值」 = channel 默认 reducer（LastValue：新值覆盖）
//   PARALLEL 分支的 Promise.all        = Send fan-out——并行从节点内部升进图拓扑，
//                                        dispatch 条件边一次发 N 个 executeOne，同 superstep 真并发
//   计划对象「一个对象走天下」         = plan（静态）与 stepStatus（动态）被迫分离——
//                                        并发节点各写各的步骤状态，塞在 plan.steps 里必然互踩
//   Promise.all 并发写互相覆盖（隐性） = InvalidUpdateError（显式）——无 reducer 的 channel
//                                        被并发写，框架直接拒绝："LastValue can only receive
//                                        one value per step"。竞态从「祈祷没错」变成「必须声明归并」
//   while 头的三分支（全done/failed/继续）= dispatch 条件边的路由函数
//   generatePlan / runStep / replan    = 节点（state 进 state 出的纯函数）
//   saveCheckpoint 落盘 JSON           = checkpointer（每次节点返回自动存快照）
//   模块 09 的权限 confirm             = interrupt() / Command({resume}) —— 框架级 human-in-the-loop
//
// 不是所有东西都被替换——zod 校验/自修一轮/步间交接文本/「保 done 不重跑」这些**业务逻辑原样搬运**：
// 框架管的是「状态怎么流」，不管「业务对不对」。
//
// 本文件是纯模块（定义 + buildGraph，无副作用）；探针/冒烟在 langgraph-planner.probe.ts：
//   node 12-capstone/langgraph-planner.probe.ts        # 探针 11 例（零 token，随时跑）
//   node 12-capstone/langgraph-planner.probe.ts smoke  # 真链冒烟（烧 token，显式要才跑）
import { z } from "zod";
import {
  Annotation,
  StateGraph,
  MemorySaver,
  START,
  END,
  interrupt,
  Send,
} from "@langchain/langgraph";

// ---------- 计划形状（模块 8 同款搬运——schema 是框架无关资产） ----------
const PlanStepSchema = z.object({
  id: z.number().int(),
  description: z.string().min(1),
  dependsOn: z.array(z.number().int()).default([]),
});
const PlanSchema = z.object({ goal: z.string(), steps: z.array(PlanStepSchema).min(1) });
export type Plan = z.infer<typeof PlanSchema>;
export type PlanStep = z.infer<typeof PlanStepSchema>;

// 动态执行态（手写版存在 plan.steps[].status/retries 里；图形态必须拆出来——见头部对照表）
export type StepState = { status: "pending" | "running" | "done" | "failed"; retries: number };

function renderPlan(plan: Plan, stepStatus: Record<number, StepState>): string {
  const ICON: Record<StepState["status"], string> = { pending: "□", running: "▶", done: "✓", failed: "✗" };
  return [
    `目标：${plan.goal}`,
    ...plan.steps.map((s) => `  ${ICON[stepStatus[s.id]?.status ?? "pending"]} [${s.id}] ${s.description}`),
  ].join("\n");
}

// runnableSteps 模块 8 同款逻辑，状态查询改走 stepStatus：pending 且依赖全 done
function runnableSteps(plan: Plan, stepStatus: Record<number, StepState>): PlanStep[] {
  const stat = (id: number) => stepStatus[id]?.status ?? "pending";
  return plan.steps.filter((s) => stat(s.id) === "pending" && s.dependsOn.every((id) => stat(id) === "done"));
}

// ---------- State：手写版的闭包变量变成显式 channels ----------
// reducer 语义是这里的教学核心：不写 reducer = LastValue（新覆盖旧，= 手写版赋值）；
// 写了 merge reducer = 并发节点各写各的 key、框架负责归并——stepStatus/stepResults 都是
// 被 Send fan-out 的并发写**逼出来**的（无 reducer 并发写直接 InvalidUpdateError，探针 P5 实证）。
// noMergeStepStatus 探针变体：故意不给 reducer，验证框架真的会拦（PITFALLS #34 同族——约定靠探针钉死）
function makeState(noMergeStepStatus = false) {
  const mergeRec = <T>() => ({
    reducer: (left: Record<number, T>, right: Record<number, T>) => ({ ...left, ...right }),
    default: () => ({}) as Record<number, T>,
  });
  return Annotation.Root({
    task: Annotation<string>, // 不可变输入
    plan: Annotation<Plan>, // 覆盖语义：makePlan/replan 整张换（静态计划）
    stepStatus: noMergeStepStatus
      ? Annotation<Record<number, StepState>>() // 探针 P5 用：无 reducer 的对照组
      : Annotation<Record<number, StepState>>(mergeRec<StepState>()), // 动态执行态：按 key 归并
    stepResults: Annotation<Record<number, string>>(mergeRec<string>()), // 步间交接载体（手写版是 Map）
    replans: Annotation<number>, // replan 熔断计数（手写版 let replans）
    log: Annotation<string[]>({
      reducer: (left, right) => left.concat(right),
      default: () => [],
    }), // appendOnly
  });
}
// 节点函数的入参形状（各 State 变体共用）
export type S = { task: string; plan: Plan; stepStatus: Record<number, StepState>; stepResults: Record<number, string>; replans: number; log: string[] };

// ---------- LLM seam：探针注假实现走零 token 路径，真链用 GLM ----------
export type LlmJsonCall = (system: string, user: string) => Promise<string>; // 返回 JSON 文本
export type StepCall = (step: PlanStep, context: string) => Promise<string>; // 返回步骤结果文本
export type Deps = { llmJson: LlmJsonCall; stepRun: StepCall; humanGate?: boolean };

const PLAN_SYSTEM = `你是 planner。把任务拆成 3~4 步执行计划。输出纯 JSON：{"goal":"...","steps":[{"id":1,"description":"...","dependsOn":[]}]}。
id 是整数。步骤尽量少，只拆真正需要分轮完成的步骤。依赖关系用 dependsOn 里的 id 表示；无依赖的步骤留空数组。`;

// ---------- 节点① makePlan = 手写 generatePlan ----------
// zod 校验 + 失败自修一轮原样保留——框架不管你的输出合不合法
async function makePlan(state: S, { llmJson }: Deps) {
  const raw = await llmJson(PLAN_SYSTEM, state.task);
  const parsed = PlanSchema.safeParse(JSON.parse(raw));
  // 教训实录（PITFALLS #34）：channel 不带 default 就是 undefined——首次经过的节点必须把全量字段补齐
  // （手写版 executePlan 开头 `const stepResults = new Map(); let replans = 0` 干的就是这件事）
  const INIT = { stepStatus: {} as Record<number, StepState>, stepResults: {} as Record<number, string>, replans: 0 };
  if (!parsed.success) {
    // 自修一轮：把 zod 错误喂回去（模块 8 双保险的简版——自修仍失败才 throw）
    const fix = await llmJson(PLAN_SYSTEM, `${state.task}\n\n上一次输出不是合法计划，zod 错误：${JSON.stringify(parsed.error.issues.map((i) => i.message))}。重新输出纯 JSON。`);
    const reparsed = PlanSchema.safeParse(JSON.parse(fix));
    if (!reparsed.success) throw new Error(`计划两轮不过 schema: ${parsed.error.message}`);
    return { ...INIT, plan: reparsed.data, log: [`[makePlan] 自修一轮通过`] };
  }
  return { ...INIT, plan: parsed.data, log: [`[makePlan] ${parsed.data.steps.length} 步计划出炉`] };
}

// ---------- 节点② dispatch：算批 + 标记 running + 人工门（手写 executePlan 每轮循环头） ----------
async function dispatch(state: S, deps: Deps) {
  // humanGate：框架级 human-in-the-loop——对照模块 09 手写的 confirm 机制。
  // interrupt() 抛 GraphInterrupt，checkpointer 存下整个 State；恢复用 Command({resume})
  if (deps.humanGate && Object.keys(state.stepResults).length === 0 && Object.keys(state.stepStatus).length === 0) {
    const approved = interrupt({ question: `计划如下，批准执行吗？\n${renderPlan(state.plan, state.stepStatus)}` });
    if (approved !== "yes") {
      // 拒绝 = 全 failed + replans 打满（熔断语义：不再重画图，出失败报告收场）
      const stepStatus: Record<number, StepState> = {};
      for (const s of state.plan.steps) stepStatus[s.id] = { status: "failed", retries: 0 };
      return { stepStatus, replans: MAX_REPLANS, log: [`[dispatch] 人工拒绝——计划中止，出失败报告`] };
    }
  }
  const runnable = runnableSteps(state.plan, state.stepStatus);
  if (!runnable.length) return {}; // 空批：让条件边走路由（finish / replan）
  // 只返回增量 patch——merge reducer 负责归并（手写版直接改 plan.steps[].status，见头部对照表）
  const patch: Record<number, StepState> = {};
  for (const s of runnable) patch[s.id] = { status: "running", retries: state.stepStatus[s.id]?.retries ?? 0 };
  return { stepStatus: patch, log: [`[dispatch] fan-out 发射 ${runnable.length} 步: ${runnable.map((s) => s.id).join(",")}`] };
}

// dispatch 之后的条件边：有 running → Send fan-out（= 手写 PARALLEL 的 Promise.all 批）；
// 没了 → 手写 while 头三分支（全 done → finish / 卡死 → replan 或熔断 / 还有 runnable → 回 dispatch）
function dispatchEdges(state: S) {
  const running = state.plan.steps.filter((s) => state.stepStatus[s.id]?.status === "running");
  if (running.length) {
    // Send 私货：executeOne 不读共享 State，拿快照输入——节点间无共享内存，交接必须显式
    return running.map((s) => new Send("executeOne", { plan: state.plan, step: s, stepResults: state.stepResults, retries: state.stepStatus[s.id]?.retries ?? 0 }));
  }
  const stat = (id: number) => state.stepStatus[id]?.status ?? "pending";
  if (state.plan.steps.every((s) => stat(s.id) === "done")) return "finish"; // 全 done → 出报告
  const stuck = state.plan.steps.some((s) => stat(s.id) === "failed") || runnableSteps(state.plan, state.stepStatus).length === 0; // failed 或悬空依赖/成环
  if (stuck) return state.replans < MAX_REPLANS ? "replanNode" : "finish"; // 熔断：失败报告也从 finish 出
  return "dispatch"; // 还有 runnable → 下一批
}

// ---------- 节点③ executeOne：跑一步（手写 runStep + 打勾/重试判定） ----------
async function executeOne(input: { plan: Plan; step: PlanStep; stepResults: Record<number, string>; retries: number }, deps: Deps) {
  const { step, stepResults, retries } = input;
  const context = step.dependsOn.map((id) => `【步骤${id}结果：${stepResults[id] ?? ""}】`).join("\n");
  let summary: string;
  try {
    summary = await deps.stepRun(step, context);
  } catch (err: any) {
    summary = `error: ${err?.message ?? ""}`; // 手写版约定：异常也是文本，喂回流程不炸图
  }
  // 打勾/重试/failed 判定——模块 8 executePlan 内联逻辑原样；只写自己的 key，merge 归并
  if (!summary.includes("error")) {
    return {
      stepStatus: { [step.id]: { status: "done", retries } } as Record<number, StepState>,
      stepResults: { [step.id]: summary } as Record<number, string>,
      log: [`[executeOne] ✓ 步骤${step.id} 完成`],
    };
  }
  if (retries >= MAX_STEP_RETRIES) {
    return {
      stepStatus: { [step.id]: { status: "failed", retries } } as Record<number, StepState>,
      stepResults: { [step.id]: summary } as Record<number, string>,
      log: [`[executeOne] ✗ 步骤${step.id} 重试用尽转 failed`],
    };
  }
  return {
    stepStatus: { [step.id]: { status: "pending", retries: retries + 1 } } as Record<number, StepState>, // 放回待重跑
    log: [`[executeOne] ↻ 步骤${step.id} 失败重试#${retries + 1}`],
  };
}

// ---------- 节点④ replanNode = 手写 replan（保 done 第一原则不变） ----------
async function replanNode(state: S, { llmJson }: Deps) {
  const doneIds = state.plan.steps.filter((s) => state.stepStatus[s.id]?.status === "done").map((s) => s.id);
  const failed = state.plan.steps
    .filter((s) => state.stepStatus[s.id]?.status === "failed")
    .map((s) => `步骤${s.id}「${s.description}」结果：${state.stepResults[s.id]}`)
    .join("\n");
  const raw = await llmJson(
    PLAN_SYSTEM,
    `原任务：${state.task}\n当前计划：${JSON.stringify(state.plan)}\n已完成步骤 id：${doneIds.join(", ")}\n失败步骤：\n${failed}\n\n重新规划。已完成的步骤（id: ${doneIds.join(", ")}）原样保留且必须保持已完成，只替换失败部分。`
  );
  const plan = PlanSchema.parse(JSON.parse(raw));
  // 状态迁移到新计划 + 代码级保证（手写版同款）：planner 说了不算，done 的强制拉回 done
  const stepStatus: Record<number, StepState> = {};
  for (const s of plan.steps) {
    stepStatus[s.id] = doneIds.includes(s.id)
      ? { status: "done", retries: state.stepStatus[s.id]?.retries ?? 0 }
      : { status: "pending", retries: 0 };
  }
  return { plan, stepStatus, replans: state.replans + 1, log: [`[replan] 第${state.replans + 1}次重画图（保 done: ${doneIds.join(",")}）`] };
}

// ---------- 节点⑤ finish：组装报告（不再调 LLM，手写版同款哲学） ----------
async function finish(state: S) {
  const all = state.plan.steps.map((s) => `【步骤${s.id} ${state.stepStatus[s.id]?.status}】${state.stepResults[s.id] ?? ""}`).join("\n");
  return { log: [`[finish] 图执行完毕\n${renderPlan(state.plan, state.stepStatus)}\n报告：\n${all}`] };
}

export const MAX_STEP_RETRIES = 2; // 同步重试上限（探针断言引用）
export const MAX_REPLANS = 3; // replan 熔断

export function buildGraph(deps: Deps, opts: { checkpointer?: MemorySaver; noMergeStepStatus?: boolean } = {}) {
  return new StateGraph(makeState(opts.noMergeStepStatus))
    .addNode("makePlan", (s: S) => makePlan(s, deps))
    .addNode("dispatch", (s: S) => dispatch(s, deps))
    .addNode("executeOne", (i: { plan: Plan; step: PlanStep; stepResults: Record<number, string>; retries: number }) => executeOne(i, deps))
    .addNode("replanNode", (s: S) => replanNode(s, deps))
    .addNode("finish", finish)
    .addEdge(START, "makePlan")
    .addEdge("makePlan", "dispatch")
    .addConditionalEdges("dispatch", dispatchEdges, {
      dispatch: "dispatch",
      executeOne: "executeOne", // Send 目标（实际发的是 Send 实例不是字符串）
      replanNode: "replanNode",
      finish: "finish",
    })
    .addEdge("executeOne", "dispatch")
    .addEdge("replanNode", "dispatch")
    .addEdge("finish", END)
    .compile({ checkpointer: opts.checkpointer });
}

