// 模块 12 §1：Vercel AI SDK 重写模块 3 的 mini_agent——同一任务，两个实现
//
// 横评方法：不是新写 demo，是拿 03-agent/mini_agent.ts 的原任务原工具重写一遍，
// 每处代码标注「你手写的 X = 这里的 Y」。识别封装，不是学用法。
//
// 对照总表（读完代码回来对）：
//   手写 while(true) 循环          = stopWhen: stepCountIs(8) —— SDK 内置循环 + 停止条件
//   手写 step > maxSteps 中止       = stepCountIs 同款（步数烧完自动停）
//   手写 JSON Schema 对象          = inputSchema: z.object(...)（zod 声明，schema 自动生成）
//   手写 dispatch（查表+parse+try） = tool() 的 execute（SDK 负责：参数解析/查表/异常反馈）
//   手写 [step N] console.log      = onStepFinish 回调（每步带 usage/toolResults，白送观测）
//   手写 messages.push(message)    = 消息滚动 SDK 全管（你根本看不到 messages 数组）
//   手写 retry/退避（模块 11）      = maxRetries 内置（默认 2）
//   手写 429/超时分类               = SDK 内部处理，你不用管（代价：黑盒，归因要看它的日志）
import "dotenv/config";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, streamText, tool, stepCountIs } from "ai";
import { z } from "zod";

// 同一端点同一模型——换的是框架层，不是模型。
// env 走 09-harness/llm.ts 的同一套 LLM_*（全仓统一入口），横评跑的就是产线同款配置
const BASE_URL = process.env.LLM_BASE_URL || "";
const MODEL = process.env.LLM_MODEL || "";

const apiKey = process.env.LLM_API_KEY;
if (!apiKey || !BASE_URL || !MODEL) {
  console.error("缺 LLM_API_KEY / LLM_BASE_URL / LLM_MODEL。请在 ai-agent-lab/.env 里配置");
  process.exit(1);
}
// 注意 .chat() 而不是 .responses()：@ai-sdk/openai 两套 API 都能出模型，
// responses 是 OpenAI 专有协议（GLM 不兼容），chat 才是通用 OpenAI 兼容层
const glm = createOpenAI({ apiKey, baseURL: BASE_URL }).chat(MODEL);

// ---------- 工具定义：模块 3 的 ToolDef 三件套 → tool() 一发 ----------
// 手写版：registry Map + registerTool() + 手拼 JSON Schema + dispatch 查表执行
// SDK 版：一个 tool() 调用全含——schema 用 zod 写（类型即 schema，不用两处维护）
const getWeather = tool({
  description: "查询某个城市当前的天气情况",
  inputSchema: z.object({
    city: z.string().describe("城市名，如：北京"),
  }),
  // 假数据固定小雨（同模块 3，保证演示路径稳定——第二跳工具是否发生取决于第一跳结果）
  execute: async ({ city }) => JSON.stringify({ city, weather: "小雨", tempC: 18 }),
});

const calculateTotal = tool({
  description: "计算总价：数量 × 单价",
  inputSchema: z.object({
    quantity: z.number().describe("数量"),
    unitPrice: z.number().describe("单价（元）"),
  }),
  execute: async ({ quantity, unitPrice }) => JSON.stringify({ total: quantity * unitPrice }),
});

// 同款 system prompt——prompt 是你自己的，框架只管循环不管人设
const SYSTEM_PROMPT = `你是一个严谨的生活助理。需要事实信息或计算时调用工具，不要凭空编造；
拿到工具结果后基于结果回答；任务完成后用不超过三句话给出最终建议。`;

// 模块 3 的原任务原句
const TASK =
  "北京今天会下雨吗？如果会下雨，我给全家 5 口人每人买一把 25 元的伞，帮我算算一共多少钱。";

// ---------- 版本一：generateText —— 整轮跑完一次拿结果 ----------
async function runGenerate() {
  console.log("========== generateText（等价于模块 3 的 agentLoop 一路跑到底） ==========");
  const started = Date.now();
  const result = await generateText({
    model: glm,
    system: SYSTEM_PROMPT,
    prompt: TASK,
    tools: { get_weather: getWeather, calculate_total: calculateTotal },
    // 手写版 while(true) + step > maxSteps 中止 → 这里一个参数
    stopWhen: stepCountIs(8),
    // 手写版循环里手打的 [step N] 调用/结果日志 → 回调白送，还带每步 usage
    onStepFinish: ({ toolResults, usage }) => {
      const names = toolResults.map((r) => r.toolName).join(", ");
      console.log(`[step] 工具: ${names || "（纯文本步）"} | 本步 tokens: ${usage.inputTokens}/${usage.outputTokens}`);
    },
  });

  console.log(`\n=== 最终回答 ===\n${result.text}`);
  console.log(
    `\n[账] 步数 ${result.steps.length} | tokens ${result.usage.inputTokens}/${result.usage.outputTokens} | 耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`
  );
  // 手写版你还亲手 push messages、亲眼看数组滚动——SDK 版消息数组被封装吞掉了，
  // 要看只能开 include: { toolResults: true } 或 debug 日志（透明度换便利，见对照表）
  return result;
}

// ---------- 版本二：streamText —— §7 前端交付的地基 ----------
// 同一套 tool/stopWhen 配置，流式形态：token 一到就吐（generateText 是攒完才给）。
// 前端打字机效果的数据源就是这个 textStream；工具步发生时 onStepFinish 照样触发
async function runStream() {
  console.log("\n========== streamText（token 一到就吐——SSE 打字机的源） ==========");
  const started = Date.now();
  let firstChunkAt = 0;
  const stream = streamText({
    model: glm,
    system: SYSTEM_PROMPT,
    prompt: TASK,
    tools: { get_weather: getWeather, calculate_total: calculateTotal },
    stopWhen: stepCountIs(8),
    onStepFinish: ({ toolResults }) => {
      const names = toolResults.map((r) => r.toolName).join(", ");
      if (names) console.log(`\n[step] 工具: ${names}`); // 工具步在流里是"暂停点"：文字停、工具跑、再继续
    },
  });

  let printed = 0;
  for await (const chunk of stream.textStream) {
    if (!firstChunkAt) {
      firstChunkAt = Date.now();
      console.log(`\n[首字延迟] ${firstChunkAt - started}ms`);
    }
    process.stdout.write(chunk); // 打字机：收到就打，不等整句
    printed += chunk.length;
  }
  // 流结束后的全账（usage 也是流末尾才齐——token 计数天然是"事后"的）
  const usage = await stream.usage;
  console.log(
    `\n\n[账] 输出 ${printed} 字符 | tokens ${usage.inputTokens}/${usage.outputTokens} | 总耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`
  );
}

await runGenerate();
await runStream();
