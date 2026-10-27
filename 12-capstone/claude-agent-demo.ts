// 模块 12 §3：Claude Agent SDK 对照模块 09 手写 harness——产品级 agent 运行时长什么样
//
// 对照总表（手写 09-harness → Claude Agent SDK）：
//   工具 allowlist（allowlist.ts）        = options.allowedTools（白名单免批）
//                                            + CLI 内置命令分级：ls 类只读命令连白名单都不用进，
//                                              默认安全规则直接放行（手写版没有这层）
//   confirm 人工审批（human-in-the-loop）  = options.canUseTool 回调——「需要审批」的工具调用
//                                            走这里，返回 allow/deny（allow 可改写参数）
//   工具注册表（registry Map）            = createSdkMcpServer + tool()——**自定义工具体就是 MCP**
//                                            （模块 4 手写过 MCP server，这里一行注册）
//   沙箱目录隔离（sandbox）               = options.cwd（agent 的工作目录整个换掉）
//   [step N] 轨迹打印                      = for await 消息流（assistant/text/tool_use 分块白送）
//   记账（onUsage 双栏）                   = result 消息 usage/num_turns/duration_ms 白送
//   maxSteps 步数保险                      = options.maxTurns
//
// 不碰的部分：hooks（子进程钩子要完整 CLI 环境）、Skills/子 agent（模块 4/5 已对照过，不重复烧）。
//
// 前置：GLM 的 anthropic 兼容端点（最小请求已验 HTTP 200，glm-5.3 走 anthropic 协议含 thinking）
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// SDK 会 spawn 一个 CLI 子进程跑真正的 agent 循环——env 走继承，这里注入 GLM 的
// anthropic 兼容端点（对照模块 11 的「跨配额池」：主档 GLM 包月同一账号换个协议皮肤）
process.env.ANTHROPIC_BASE_URL = "https://open.bigmodel.cn/api/anthropic";
process.env.ANTHROPIC_API_KEY = process.env.LLM_API_KEY || "";
process.env.ANTHROPIC_MODEL = process.env.LLM_MODEL || "glm-5.3";
const MODEL = process.env.ANTHROPIC_MODEL;

if (!process.env.LLM_API_KEY) {
  console.error("缺 LLM_API_KEY（写进 .env，SDK 会透传给 anthropic 兼容端点）");
  process.exit(1);
}

// 沙箱：agent 的 cwd 整个换成这里（对照模块 09 沙箱——最小权限的物理版）
const SANDBOX = path.resolve(import.meta.dirname, "sdk-sandbox");
const DONE_FILE = path.join(SANDBOX, "done.txt");

// ---------- 自定义工具：SDK MCP server（= 模块 4 的 MCP + 模块 09 registry 的合体形态） ----------
let recorded: string | null = null; // 台账落在进程内存（教学 demo 不写文件——沙箱保持干净）
const demoServer = createSdkMcpServer({
  name: "demo-tools",
  version: "1.0.0",
  // alwaysLoad：不把 record 藏到 ToolSearch 后面（默认 defer 省 token——但工具搜索
  // 对非 Claude 模型水土不服，实测 glm-5.3 三轮搜索全空、任务直接卡死，见 TUTORIAL）
  alwaysLoad: true,
  tools: [
    tool(
      "record",
      "把一句话总结记录到产线台账",
      { summary: z.string().describe("一句话总结") },
      async ({ summary }) => {
        recorded = summary;
        console.log(`\n[record 工具] 已记录: ${summary}`);
        return { content: [{ type: "text", text: `已记录: ${summary}` }] };
      }
    ),
  ],
});

// ---------- 权限回调：需要审批的工具调用走这里（= 模块 09 confirm 的框架版） ----------
// 实测语义：canUseTool 只对「需要审批」的工具触发——Bash(ls) 这类只读命令被 CLI
// 默认安全规则直接放行，回调压根不响（对照发现：CLI 内置命令分级）
const approvals: { tool: string; input: Record<string, unknown>; allowed: boolean }[] = [];
async function canUseTool(toolName: string, input: Record<string, unknown>) {
  // 注意匹配的是工具全名：MCP 工具到权限层是 mcp__demo-tools__record 不是短名 record
  const allowed = toolName === "Write" || toolName.includes("record");
  approvals.push({ tool: toolName, input, allowed });
  console.log(`\n[confirm] ${toolName} 请求审批 → 模拟人工${allowed ? "同意" : "拒绝"}（对照模块 09 confirm）`);
  console.log(`  入参: ${JSON.stringify(input).slice(0, 120)}`);
  return allowed
    ? { behavior: "allow" as const, updatedInput: input }
    : { behavior: "deny" as const, message: `工具 ${toolName} 未获批准，换别的方法完成。` };
}

// ---------- 跑一发：一条链看全三层 ----------
// ① Bash(ls) 被 CLI 默认安全规则放行（只读命令免审——对照发现）
// ② Write 弹 confirm：canUseTool 收到 → 模拟人工同意 → done.txt 真写进沙箱
// ③ record 走 MCP 自定义工具落台账
const TASK = `先用 Bash 运行 ls 列出当前目录的文件；然后读 test.txt；用 Write 创建 done.txt（内容就一行：done）；最后用 record 工具把 test.txt 的核心内容总结成一句话记录。`;

console.log(`[环境] model=${MODEL} cwd=${SANDBOX}`);
console.log(`[任务] ${TASK}\n`);
const t0 = Date.now();

const q = query({
  prompt: TASK,
  options: {
    model: MODEL,
    cwd: SANDBOX,
    maxTurns: 10, // deny-重试会烧轮次，8 太紧（实测一次误拒 3 连就把预算烧穿熔断）
    // 显式列出 = 直接进 prompt 不 defer（默认 defer 到 ToolSearch 后——GLM 搜不到，实测卡死）
    tools: ["Read", "Glob", "Bash", "Write"],
    // permissionMode 显式 'default'：实测不写时 Write 被静默放行（疑似默认 acceptEdits
    // ——文件编辑自动接受），canUseTool 一次不响；'default' = 需要审批的走 canUseTool
    permissionMode: "default",
    allowedTools: ["Read", "Glob"], // 白名单：免批直用（对照 09 allowlist）；Write 故意不进——留给 confirm
    mcpServers: { "demo-tools": demoServer },
    canUseTool, // 需要审批的走这里
  },
});

let result: any = null;
for await (const m of q as AsyncIterable<any>) {
  if (m.type === "assistant") {
    for (const b of m.message.content as any[]) {
      if (b.type === "text") console.log(`[assistant] ${b.text.slice(0, 200)}`);
      if (b.type === "tool_use") console.log(`[tool_use] ${b.name} ${JSON.stringify(b.input).slice(0, 80)}`);
    }
  } else if (m.type === "result") {
    result = m;
  }
}

console.log("\n========== 收官对账 ==========");
console.log(`[审批] confirm 触发 ${approvals.length} 次: ${approvals.map((a) => `${a.tool}(${a.allowed ? "同意" : "拒绝"})`).join(", ") || "（无）"}`);
let doneWritten: string | null = null;
try { doneWritten = await fs.readFile(DONE_FILE, "utf8"); } catch { /* 没写成 */ }
console.log(`[confirm 副作用] done.txt ${doneWritten ? `真写入: ${JSON.stringify(doneWritten)}` : "未写入"}`);
console.log(`[台账] record 落账: ${recorded ?? "（未落——record 没被调用）"}`);
if (result) {
  console.log(
    `[账] subtype=${result.subtype} turns=${result.num_turns} tokens=${result.usage?.input_tokens}/${result.usage?.output_tokens} 耗时=${result.duration_ms}ms（墙钟 ${Date.now() - t0}ms）`
  );
}

// 验收（探针语义）：Write 审批真发生 / 放行副作用真落地 / record 真落账 / 全程不熔断
const PASS =
  approvals.some((a) => a.allowed) &&
  doneWritten !== null &&
  recorded !== null &&
  result?.subtype === "success";
console.log(`\n验收: ${PASS ? "✓ confirm+放行副作用+MCP 落账全链通过" : "✗ 有环节没走通——看上面日志归因"}`);
if (!PASS) process.exitCode = 1;

// 清场：confirm 放行的副作用验证完就删，沙箱可重复跑
if (doneWritten) await fs.rm(DONE_FILE);
