// 模块 12 §2：LangGraph.js 重写模块 8 的 planner-executor——同一调度逻辑，图形态
//
// 对照总表（手写 planner.ts → LangGraph.js）：
//   executePlan 的 while(true) 循环   = 图本身（addConditionalEdges 循环回边）——循环变成拓扑
//   plan / stepResults / replans 变量 = State channels（每个字段一个 Annotation）
//   「plan = await replan(...) 赋值」 = channel 默认 reducer（LastValue：新值覆盖）
//   console.log 轨迹                  = log channel + reducer（appendOnly 归并——本文件唯一自定 reducer）
//   while 头的三分支（全done/failed/继续）= addConditionalEdges 的路由函数
//   generatePlan / runStep / replan    = 三个节点（节点 = state 进 state 出的纯函数）
//   saveCheckpoint 落盘 JSON           = checkpointer（MemorySaver：每次节点返回自动存快照）
//   模块 09 的权限 confirm             = interrupt() / Command({resume}) —— 框架级 human-in-the-loop
//
// 不是所有东西都被替换——zod 校验/自修一轮/步间交接文本/「保 done 不重跑」这些**业务逻辑原样搬运**：
// 框架管的是「状态怎么流」，不管「业务对不对」。
import "dotenv/config";
import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import {
  Annotation,
  StateGraph,
  MemorySaver,
  START,
  END,
  Command,
  interrupt,
} from "@langchain/langgraph";

// ---------- 计划形状（模块 8 同款搬运——schema 是框架无关资产） ----------
const PlanStepSchema = z.object({
  id: z.number().int(),
  description: z.string().min(1),
  dependsOn: z.array(z.number().int()).default([]),
  status: z.enum(["pending", "running", "done", "failed"]).default("pending"),
  retries: z.number().int().default(0),
});
const PlanSchema = z.object({ goal: z.string(), steps: z.array(PlanStepSchema).min(1) });
type Plan = z.infer<typeof PlanSchema>;
type PlanStep = z.infer<typeof PlanStepSchema>;

function renderPlan(plan: Plan): string {
  const ICON: Record<PlanStep["status"], string> = { pending: "□", running: "▶", done: "✓", failed: "✗" };
  return [
    `目标：${plan.goal}`,
    ...plan.steps.map((s) => `  ${ICON[s.status]} [${s.id}] ${s.description}`),
  ].join("\n");
}

// runnableSteps 模块 8 同款：pending 且依赖全 done（返回数组，并发接口天然留好）
function runnableSteps(plan: Plan): PlanStep[] {
  const map = new Map(plan.steps.map((s) => [s.id, s]));
  return plan.steps.filter(
    (s) => s.status === "pending" && s.dependsOn.every((id) => map.get(id)?.status === "done")
  );
}

// ---------- State：手写版的三个闭包变量变成显式 channels ----------
// reducer 语义是这里的教学核心：不写 reducer = LastValue（新覆盖旧，= 手写版 `plan = ...` 赋值）；
// log 写了 append reducer = 多节点并发追加不丢（手写版靠单线程顺序天然安全）
const PlannerState = Annotation.Root({
  task: Annotation<string>, // 不可变输入
  plan: Annotation<Plan>, // 覆盖语义：makePlan/replan 整张换
  stepResults: Annotation<Record<number, string>>, // 步间交接载体（手写版是 Map）
  replans: Annotation<number>, // replan 熔断计数（手写版 let replans）
  log: Annotation<string[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }), // 唯一自定义 reducer：appendOnly
});

// ---------- LLM seam：探针注假实现走零 token 路径，真链用 GLM ----------
type LlmJsonCall = (system: string, user: string) => Promise<string>; // 返回 JSON 文本
type StepCall = (step: PlanStep, context: string) => Promise<string>; // 返回步骤结果文本
type Deps = { llmJson: LlmJsonCall; stepRun: StepCall; humanGate?: boolean };

const PLAN_SYSTEM = `你是 planner。把任务拆成 3~4 步执行计划。输出纯 JSON：{"goal":"...","steps":[{"id":1,"description":"...","dependsOn":[]}]}。
id 是整数。步骤尽量少，只拆真正需要分轮完成的步骤。依赖关系用 dependsOn 里的 id 表示。`;

// ---------- 节点① makePlan = 手写 generatePlan ----------
// zod 校验 + 失败自修一轮原样保留——框架不管你的输出合不合法
async function makePlan(state: typeof PlannerState.State, { llmJson }: Deps) {
  const raw = await llmJson(PLAN_SYSTEM, state.task);
  const parsed = PlanSchema.safeParse(JSON.parse(raw));
  // 教训实录：channel 不带 default 就是 undefined——首次经过的节点必须把全量字段补齐
  // （手写版 executePlan 开头 `const stepResults = new Map(); let replans = 0` 干的就是这件事）
  const INIT = { stepResults: {} as Record<number, string>, replans: 0 };
  if (!parsed.success) {
    // 自修一轮：把 zod 错误喂回去（模块 8 双保险的简版——自修仍失败才 throw）
    const fix = await llmJson(PLAN_SYSTEM, `${state.task}\n\n上一次输出不是合法计划，zod 错误：${JSON.stringify(parsed.error.issues.map((i) => i.message))}。重新输出纯 JSON。`);
    const reparsed = PlanSchema.safeParse(JSON.parse(fix));
    if (!reparsed.success) throw new Error(`计划两轮不过 schema: ${parsed.error.message}`);
    return { ...INIT, plan: reparsed.data, log: [`[makePlan] 自修一轮通过`] };
  }
  return { ...INIT, plan: parsed.data, log: [`[makePlan] ${parsed.data.steps.length} 步计划出炉`] };
}

// ---------- 节点② executeSteps = runnableSteps + runStep + 打勾/重试 ----------
async function executeSteps(state: typeof PlannerState.State, deps: Deps) {
  // humanGate：框架级 human-in-the-loop——对照模块 09 手写的 confirm 机制。
  // interrupt() 抛 GraphInterrupt，checkpointer 存下整个 State；恢复用 Command({resume})
  if (deps.humanGate && Object.keys(state.stepResults).length === 0) {
    const approved = interrupt({ question: `计划如下，批准执行吗？\n${renderPlan(state.plan)}` });
    if (approved !== "yes") return { log: [`[executeSteps] 人工拒绝，计划中止`] };
  }
  const plan = structuredClone(state.plan); // 手写版直接改闭包里的对象；图节点要返回新引用（状态不可变语义）
  const runnable = runnableSteps(plan);
  const results = { ...state.stepResults };
  const log: string[] = [];
  for (const step of runnable) {
    step.status = "running";
    const context = step.dependsOn.map((id) => `【步骤${id}结果：${results[id] ?? ""}】`).join("\n");
    let summary: string;
    try {
      summary = await deps.stepRun(step, context);
    } catch (err: any) {
      summary = `error: ${err?.message ?? ""}`; // 手写版约定：异常也是文本，喂回流程不炸图
    }
    // 打勾/重试/failed 判定——模块 8 executePlan 内联逻辑原样
    if (!summary.includes("error")) {
      step.status = "done";
      results[step.id] = summary;
      log.push(`[executeSteps] ✓ 步骤${step.id} 完成`);
    } else if (step.retries >= MAX_STEP_RETRIES) {
      step.status = "failed";
      results[step.id] = summary;
      log.push(`[executeSteps] ✗ 步骤${step.id} 重试用尽转 failed`);
    } else {
      step.retries++;
      step.status = "pending"; // 放回待重跑（手写版同款：pending 回炉）
      log.push(`[executeSteps] ↻ 步骤${step.id} 失败重试#${step.retries}`);
    }
  }
  return { plan, stepResults: results, log };
}

// ---------- 节点③ replanNode = 手写 replan（保 done 第一原则不变） ----------
async function replanNode(state: typeof PlannerState.State, { llmJson }: Deps) {
  const doneIds = state.plan.steps.filter((s) => s.status === "done").map((s) => s.id);
  const failed = state.plan.steps
    .filter((s) => s.status === "failed")
    .map((s) => `步骤${s.id}「${s.description}」结果：${state.stepResults[s.id]}`)
    .join("\n");
  const raw = await llmJson(
    PLAN_SYSTEM,
    `原任务：${state.task}\n当前计划：${JSON.stringify(state.plan)}\n失败步骤：\n${failed}\n\n重新规划。已完成的步骤（id: ${doneIds.join(", ")}）原样保留且 status 必须为 done，只替换失败部分。`
  );
  const plan = PlanSchema.parse(JSON.parse(raw));
  // 代码级保证（手写版同款）：planner 说了不算，done 的强制拉回 done
  for (const old of state.plan.steps.filter((s) => s.status === "done")) {
    const again = plan.steps.find((s) => s.id === old.id);
    if (again) again.status = "done";
  }
  return { plan, replans: state.replans + 1, log: [`[replan] 第${state.replans + 1}次重画图（保 done: ${doneIds.join(",")}）`] };
}

// ---------- 节点④ finish：组装报告（不再调 LLM，手写版同款哲学） ----------
async function finish(state: typeof PlannerState.State) {
  const all = state.plan.steps.map((s) => `【步骤${s.id} ${s.status}】${state.stepResults[s.id] ?? ""}`).join("\n");
  return { log: [`[finish] 图执行完毕\n${renderPlan(state.plan)}\n报告：\n${all}`] };
}

// ---------- 路由 = 手写 while 头的三分支 ----------
const MAX_STEP_RETRIES = 2; // 同步重试上限
const MAX_REPLANS = 3; // replan 熔断

function route(state: typeof PlannerState.State): "executeSteps" | "replanNode" | "finish" {
  const steps = state.plan.steps;
  if (steps.every((s) => s.status === "done")) return "finish"; // 全 done → 出报告
  const stuck = steps.some((s) => s.status === "failed") || runnableSteps(state.plan).length === 0; // failed 或悬空依赖/成环
  if (stuck) return state.replans < MAX_REPLANS ? "replanNode" : "finish"; // 熔断：失败报告也从 finish 出
  return "executeSteps"; // 还有 runnable → 继续跑
}

function buildGraph(deps: Deps, checkpointer?: MemorySaver) {
  return new StateGraph(PlannerState)
    .addNode("makePlan", (s) => makePlan(s, deps))
    .addNode("executeSteps", (s) => executeSteps(s, deps))
    .addNode("replanNode", (s) => replanNode(s, deps))
    .addNode("finish", finish)
    .addEdge(START, "makePlan")
    .addEdge("makePlan", "executeSteps")
    .addConditionalEdges("executeSteps", route, {
      executeSteps: "executeSteps",
      replanNode: "replanNode",
      finish: "finish",
    })
    .addEdge("replanNode", "executeSteps")
    .addEdge("finish", END)
    .compile({ checkpointer });
}

// ---------- 探针（零 token，seam 注假实现） ----------
// #33 教训照办：seam 探针之外必须有最小真链冒烟（本文件底部）
async function runProbes() {
  console.log("========== 探针（假 LLM，零 token） ==========");
  let pass = 0, total = 0;
  const check = (name: string, ok: boolean, detail = "") => {
    total++; if (ok) pass++;
    console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `（${detail}）` : ""}`);
  };

  // P1 正常路径：3 步全成
  {
    const calls: number[] = [];
    const g = buildGraph({
      llmJson: async (_s, u) => (u.includes("原任务") ? JSON.stringify({ goal: "g", steps: [{ id: 9, description: "x" }] }) : JSON.stringify({ goal: "选型", steps: [
        { id: 1, description: "步骤一" }, { id: 2, description: "步骤二", dependsOn: [1] }, { id: 3, description: "步骤三", dependsOn: [2] }] })),
      stepRun: async (s) => { calls.push(s.id); return `结果${s.id}`; },
    });
    const r = await g.invoke({ task: "t" });
    check("P1 全 done 走 finish", r.plan.steps.every((s) => s.status === "done") && r.log.some((l) => l.includes("[finish]")));
    check("P1 依赖顺序 1→2→3", JSON.stringify(calls) === "[1,2,3]");
  }

  // P2 失败→重试用尽→replan→保 done 不重跑
  {
    const stepCalls: number[] = [];
    let planCalls = 0;
    const g = buildGraph({
      llmJson: async () => {
        planCalls++;
        return planCalls === 1
          ? JSON.stringify({ goal: "g", steps: [{ id: 1, description: "好的步骤" }, { id: 2, description: "坏步骤", dependsOn: [1] }] })
          : JSON.stringify({ goal: "g", steps: [{ id: 1, description: "好的步骤" }, { id: 2, description: "替换步骤", dependsOn: [1] }] });
      },
      stepRun: async (s) => { stepCalls.push(s.id); return s.description === "坏步骤" ? "error: 模拟失败" : `结果${s.id}`; },
    });
    const r = await g.invoke({ task: "t" });
    const step1Runs = stepCalls.filter((id) => id === 1).length;
    check("P2 replan 触发且最终全 done", r.plan.steps.every((s) => s.status === "done") && r.replans === 1);
    check("P2 保 done：步骤1 跨 replan 只跑 1 次", step1Runs === 1, `步骤1 实跑 ${step1Runs} 次，全部调用序列 [${stepCalls}]`);
    check("P2 重试上限生效：坏步骤试 MAX+1 次后 failed", stepCalls.filter((id) => id === 2).length === MAX_STEP_RETRIES + 2, "3 次耗尽 + 1 次替换成功");
  }

  // P3 replan 熔断：replan 后替换步骤仍恒败 → MAX_REPLANS 用尽出失败报告
  {
    let planCalls = 0;
    const g = buildGraph({
      llmJson: async () => {
        planCalls++;
        return planCalls === 1
          ? JSON.stringify({ goal: "g", steps: [{ id: 1, description: "好" }, { id: 2, description: "坏", dependsOn: [1] }] })
          : JSON.stringify({ goal: "g", steps: [{ id: 1, description: "好" }, { id: 3, description: "还是坏", dependsOn: [1] }] });
      },
      stepRun: async (s) => (s.description.includes("坏") ? "error: 模拟失败" : "ok"),
    });
    const r = await g.invoke({ task: "t" });
    check("P3 熔断：replans 打满停机", r.replans === MAX_REPLANS);
    check("P3 失败报告含 failed 步骤", r.log.some((l) => l.includes("failed")));
  }

  // P4 checkpointer：interrupt 中断 + Command 恢复（对照模块 09 会话存档 resume）
  {
    const checkpointer = new MemorySaver();
    const g = buildGraph(
      { llmJson: async () => JSON.stringify({ goal: "g", steps: [{ id: 1, description: "一" }, { id: 2, description: "二", dependsOn: [1] }] }),
        stepRun: async (s) => `结果${s.id}`, humanGate: true },
      checkpointer
    );
    const config = { configurable: { thread_id: "p4" } };
    const r1 = await g.invoke({ task: "t" }, config);
    const interrupted = (r1 as any).__interrupt__ !== undefined;
    const snapshot = await g.getState(config);
    const hasPending = snapshot.values.plan?.steps.some((s: PlanStep) => s.status === "pending");
    check("P4 interrupt 真中断（首批步骤前停）", interrupted && hasPending && snapshot.next.length > 0);
    const r2: any = await g.invoke(new Command({ resume: "yes" }), config);
    check("P4 Command 恢复跑完全 done", r2.plan.steps.every((s: PlanStep) => s.status === "done"));
  }

  console.log(`\n探针：${pass}/${total} 通过`);
  if (pass !== total) process.exitCode = 1;
}

// ---------- 真链冒烟（烧 token）：GLM 真计划 + 真执行 + 真中断恢复 ----------
async function runSmoke() {
  console.log("\n========== 真链冒烟（GLM） ==========");
  const BASE_URL = process.env.LLM_BASE_URL || "";
  const MODEL = process.env.LLM_MODEL || "";
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey || !BASE_URL || !MODEL) { console.error("缺 LLM_* env"); process.exit(1); }
  const llm = new ChatOpenAI({ model: MODEL, apiKey, configuration: { baseURL: BASE_URL } });

  const llmJson: LlmJsonCall = async (system, user) => {
    const r = await llm.invoke([{ role: "system", content: system }, { role: "user", content: user }]);
    return String(r.content);
  };
  const stepRun: StepCall = async (step, context) => {
    const r = await llm.invoke([
      { role: "system", content: `你是执行器。当前计划进度里你负责一步，输出该步的成果（200 字内），不要寒暄。` },
      { role: "user", content: `计划上下文：${context}\n\n本步骤指令：${step.description}` },
    ]);
    return String(r.content);
  };

  const checkpointer = new MemorySaver();
  const g = buildGraph({ llmJson, stepRun, humanGate: true }, checkpointer);
  const config = { configurable: { thread_id: `smoke-${Date.now()}` } };
  const task = "对比 Vercel AI SDK、LangGraph.js、Claude Agent SDK 三个 TS agent 框架：各自的核心抽象是什么、适合什么场景、给一个选型建议。";

  const t0 = Date.now();
  const r1: any = await g.invoke({ task }, config);
  const gate = (r1 as any).__interrupt__?.[0]?.value as { question: string } | undefined;
  console.log(`\n[interrupt] 人工门触发（耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）：\n${gate?.question ?? "（未触发）"}`);
  const snap = await g.getState(config);
  console.log(`[checkpointer] 中断点 next=${JSON.stringify(snap.next)}，快照里有 ${snap.values.plan?.steps.length} 步计划`);
  console.log("\n--- 输入 yes 恢复执行 ---\n");
  const r2: any = await g.invoke(new Command({ resume: "yes" }), config);
  for (const line of r2.log) console.log(line);
  console.log(`\n[账] 总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s | replans ${r2.replans}`);
}

// 探针默认跑；SKIP_PROBES=1 只跑真链（探针挂了别用这开关绕过——先修探针）
if (process.env.SKIP_PROBES !== "1") await runProbes();
await runSmoke();
