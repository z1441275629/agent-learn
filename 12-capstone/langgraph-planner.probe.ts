// 模块 12 §2 探针 + 真链冒烟（langgraph-planner.ts 的测试侧——主文件是纯模块）
//
// 用法：
//   node 12-capstone/langgraph-planner.probe.ts        # 探针 11 例（零 token，随时跑）
//   node 12-capstone/langgraph-planner.probe.ts smoke  # 真链冒烟（烧 token，显式要才跑）
//
// #33 教训照办：seam 探针（假 LLM 走零 token 路径）之外，改动后必须跑一发最小真链冒烟。
// 探针挂先查断言再查实现（本模块已兑现两次）。
import "dotenv/config";
import { ChatOpenAI } from "@langchain/openai";
import { MemorySaver, Command } from "@langchain/langgraph";
import {
  buildGraph,
  MAX_STEP_RETRIES,
  MAX_REPLANS,
  type Plan,
  type PlanStep,
  type StepState,
  type Deps,
  type LlmJsonCall,
  type StepCall,
} from "./langgraph-planner.ts";

// ---------- 探针（零 token，seam 注假实现） ----------
async function runProbes() {
  console.log("========== 探针（假 LLM，零 token） ==========");
  let pass = 0, total = 0;
  const check = (name: string, ok: boolean, detail = "") => {
    total++; if (ok) pass++;
    console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `（${detail}）` : ""}`);
  };
  const threeStepPlan = JSON.stringify({ goal: "选型", steps: [
    { id: 1, description: "步骤一" }, { id: 2, description: "步骤二", dependsOn: [1] }, { id: 3, description: "步骤三", dependsOn: [2] }] });

  // P1 依赖链：1→2→3 批间串行（依赖决定）
  {
    const calls: number[] = [];
    const g = buildGraph({ llmJson: async () => threeStepPlan, stepRun: async (s) => { calls.push(s.id); return `结果${s.id}`; } });
    const r: any = await g.invoke({ task: "t" }, { recursionLimit: 100 });
    check("P1 全 done 走 finish", Object.values(r.stepStatus).every((v: any) => v.status === "done"));
    check("P1 依赖顺序 1→2→3", JSON.stringify(calls) === "[1,2,3]");
  }

  // P1b 无依赖三步：Send fan-out 真并发（手写 PARALLEL 分支的对照）——inFlight 峰值必须 > 1
  {
    let inFlight = 0, peak = 0;
    const freePlan = JSON.stringify({ goal: "并行", steps: [{ id: 1, description: "一" }, { id: 2, description: "二" }, { id: 3, description: "三" }] });
    const g = buildGraph({
      llmJson: async () => freePlan,
      stepRun: async (s) => { inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 30)); inFlight--; return `结果${s.id}`; },
    });
    const r: any = await g.invoke({ task: "t" }, { recursionLimit: 100 });
    check("P1b 无依赖三步并发执行（peak>1）", peak === 3 && Object.values(r.stepStatus).every((v: any) => v.status === "done"), `inFlight 峰值 ${peak}`);
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
    const r: any = await g.invoke({ task: "t" }, { recursionLimit: 100 });
    const step1Runs = stepCalls.filter((id) => id === 1).length;
    check("P2 replan 触发且最终全 done", Object.values(r.stepStatus).every((v: any) => v.status === "done") && r.replans === 1);
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
    const r: any = await g.invoke({ task: "t" }, { recursionLimit: 100 });
    check("P3 熔断：replans 打满停机", r.replans === MAX_REPLANS);
    check("P3 失败报告含 failed 步骤", Object.values(r.stepStatus).some((v: any) => v.status === "failed"));
  }

  // P4 checkpointer：interrupt 中断 + Command 恢复（对照模块 09 会话存档 resume）
  {
    const checkpointer = new MemorySaver();
    const g = buildGraph(
      { llmJson: async () => threeStepPlan, stepRun: async (s) => `结果${s.id}`, humanGate: true },
      { checkpointer }
    );
    const config = { configurable: { thread_id: "p4" } };
    const r1 = await g.invoke({ task: "t" }, { ...config, recursionLimit: 100 });
    const interrupted = (r1 as any).__interrupt__ !== undefined;
    const snapshot = await g.getState(config);
    const hasPending = snapshot.values.plan?.steps.some((_: any) => true) && Object.keys(snapshot.values.stepStatus ?? {}).length === 0;
    check("P4 interrupt 真中断（首批步骤前停）", interrupted && hasPending && snapshot.next.includes("dispatch"), `next=${JSON.stringify(snapshot.next)}`);
    const r2: any = await g.invoke(new Command({ resume: "yes" }), { ...config, recursionLimit: 100 });
    check("P4 Command 恢复跑完全 done", Object.values(r2.stepStatus).every((v: any) => v.status === "done"));
  }

  // P5 并发写无 reducer 的 channel → 框架显式拒绝（模块 8「Promise.all 并发写互相覆盖」的框架版：
  // 手写版隐性竞态静默出错，LangGraph 直接 InvalidUpdateError 逼你声明归并语义）
  {
    const freePlan = JSON.stringify({ goal: "并行", steps: [{ id: 1, description: "一" }, { id: 2, description: "二" }] });
    const g = buildGraph({ llmJson: async () => freePlan, stepRun: async (s) => `结果${s.id}` }, { noMergeStepStatus: true });
    let msg = "";
    try { await g.invoke({ task: "t" }, { recursionLimit: 100 }); } catch (e: any) { msg = String(e?.message ?? ""); }
    check("P5 无 reducer 并发写被框架拦", msg.includes("Invalid update") && msg.includes("LastValue"), msg.slice(0, 80));
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

  // 模块 8 的三层保险（纯 JSON 提示词 + 剥围栏 + zod 自修）我「简版」省了剥围栏——
  // 上一发冒烟没围栏侥幸通过，这一发带 json 围栏当场炸：n=1 绿不等于稳。
  // 花括号切片比剥 fence 鲁棒（围栏/寒暄/尾随句都剥得掉）
  const extractJson = (raw: string) => {
    const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
    return start >= 0 && end > start ? raw.slice(start, end + 1) : raw.trim();
  };
  const llmJson: LlmJsonCall = async (system, user) => {
    const r = await llm.invoke([{ role: "system", content: system }, { role: "user", content: user }]);
    return extractJson(String(r.content));
  };
  const stepRun: StepCall = async (step, context) => {
    const r = await llm.invoke([
      { role: "system", content: `你是执行器。当前计划进度里你负责一步，输出该步的成果（200 字内），不要寒暄。` },
      { role: "user", content: `计划上下文：${context}\n\n本步骤指令：${step.description}` },
    ]);
    return String(r.content);
  };

  const checkpointer = new MemorySaver();
  const g = buildGraph({ llmJson, stepRun, humanGate: true }, { checkpointer });
  const config = { configurable: { thread_id: `smoke-${Date.now()}` } };
  const task = "对比 Vercel AI SDK、LangGraph.js、Claude Agent SDK 三个 TS agent 框架：各自的核心抽象是什么、适合什么场景、给一个选型建议。";

  const t0 = Date.now();
  const r1: any = await g.invoke({ task }, { ...config, recursionLimit: 100 });
  const gate = (r1 as any).__interrupt__?.[0]?.value as { question: string } | undefined;
  console.log(`\n[interrupt] 人工门触发（耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）：\n${gate?.question ?? "（未触发）"}`);
  const snap = await g.getState(config);
  console.log(`[checkpointer] 中断点 next=${JSON.stringify(snap.next)}，快照里有 ${snap.values.plan?.steps.length} 步计划`);
  console.log("\n--- 输入 yes 恢复执行 ---\n");
  const r2: any = await g.invoke(new Command({ resume: "yes" }), { ...config, recursionLimit: 100 });
  for (const line of r2.log) console.log(line);
  console.log(`\n[账] 总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s | replans ${r2.replans}`);
}

if (process.argv[2] === "smoke") {
  await runSmoke();
} else {
  await runProbes();
}
