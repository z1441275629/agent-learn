// 模块 1：Function Calling —— 手写最小可用版本
//
// 你已经能跑通的：client 初始化、工具的 JSON Schema 定义、两个工具函数。
// 你的任务：只写 run() 里的【三段 TODO】，其他地方不要动。
//
// 写之前先记住一个面试核心答案：
//   模型从来不执行函数。它只是输出"我想调用 get_weather，参数是 {city: 北京}"
//   这样的 JSON；真正执行的是你这边的代码，你再把结果喂回给模型。
//   openai SDK 帮你做的只是 JSON 的序列化/反序列化。
import "dotenv/config";
import OpenAI from "openai";

// GLM Coding Plan 套餐专用端点；如果你买的是按量付费 API 额度，改成 https://open.bigmodel.cn/api/paas/v4
// 这两个常量就是"换厂商"的全部成本——OpenAI 兼容协议是事实标准
const BASE_URL = "https://open.bigmodel.cn/api/coding/paas/v4";
const MODEL = "glm-4.6"; // 也可试 glm-4.5-air（更省）、glm-4.7（更强）

const apiKey = process.env.GLM_API_KEY;
if (!apiKey) {
  console.error("没找到 GLM_API_KEY。请在 ai-agent-lab/.env 里写入一行：GLM_API_KEY=你的key");
  process.exit(1);
}
const client = new OpenAI({ apiKey, baseURL: BASE_URL });

// ---------- 第一部分：工具的"说明书"（JSON Schema），这段是给你看的不用写 ----------
// 这份 schema 会被原样发给模型，模型靠它知道有哪些工具、参数长什么样。
const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "查询某个城市当前的天气情况",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string", description: "城市名的拼音或英文，如 Beijing、Shanghai；中文查不到" },
        },
        required: ["city"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calculate",
      description: "计算一个四则运算表达式的结果",
      parameters: {
        type: "object",
        properties: {
          expression: { type: "string", description: "表达式，如：3*7+2" },
        },
        required: ["expression"],
      },
    },
  },
] as const;

// WMO weather_code 转天气描述（这才是真正的天气码，来自 forecast 接口）
// geocoding 的 feature_code 是"地点类型"（PPLC=首都），和天气无关
function wmoCodeToWeather(code: number): string {
  const map: Record<number, string> = {
    0: "晴", 1: "基本晴", 2: "多云", 3: "阴",
    45: "雾", 48: "雾凇",
    51: "毛毛雨", 61: "小雨", 63: "中雨", 65: "大雨",
    71: "小雪", 73: "中雪", 75: "大雪",
    80: "阵雨", 95: "雷暴", 96: "雷暴伴冰雹",
  };
  return map[code] ?? `未知天气码(${code})`;
}

// ---------- 第二部分：真正的工具实现（你的本地函数） ----------
async function getWeather(city: string): Promise<string> {
  // 第 1 步：geocoding 只干一件事——城市名换坐标（检索索引只认拼音/英文）
  const geo = (await (await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh`
  )).json()) as { results?: { latitude: number; longitude: number; name: string }[] };
  if (!geo.results?.length) {
    // 查不到也返回结构化错误，模型拿到后会自己决定下一步（比如换拼音重试）
    return JSON.stringify({ error: `未找到城市"${city}"，需用拼音或英文，如 Beijing` });
  }
  const { latitude, longitude, name } = geo.results[0];

  // 第 2 步：forecast 拿坐标换天气（temperature_2m 默认摄氏度，单位见响应里的 current_units）
  const wx = (await (await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code&timezone=auto`
  )).json()) as { current: { weather_code: number; temperature_2m: number } };

  return JSON.stringify({
    city: name,
    weather: wmoCodeToWeather(wx.current.weather_code),
    tempC: wx.current.temperature_2m,
  });
}

// 安全计算器：手写递归下降解析器，绝不用 eval（模型给的字符串同样是"不可信输入"）。
// 顺带一提：这就是前端写模板引擎/表达式插件时的那套最小解析器。
const OPS: Record<string, (a: number, b: number) => number> = {
  "+": (a, b) => a + b,
  "-": (a, b) => a - b,
  "*": (a, b) => a * b,
  "/": (a, b) => a / b,
};

function evalExpr(raw: string): number {
  const src = raw.replace(/\s/g, "");
  let pos = 0;

  function parseExpr(): number {
    // 加减，优先级最低
    let left = parseTerm();
    while (src[pos] === "+" || src[pos] === "-") {
      const op = src[pos++];
      left = OPS[op](left, parseTerm());
    }
    return left;
  }
  function parseTerm(): number {
    // 乘除，优先级更高
    let left = parseAtom();
    while (src[pos] === "*" || src[pos] === "/") {
      const op = src[pos++];
      left = OPS[op](left, parseAtom());
    }
    return left;
  }
  function parseAtom(): number {
    if (src[pos] === "(") {
      pos++;
      const v = parseExpr();
      if (src[pos] !== ")") throw new Error("缺少右括号");
      pos++;
      return v;
    }
    const m = /^\d+(\.\d+)?/.exec(src.slice(pos));
    if (!m) throw new Error(`位置 ${pos} 处无法解析`);
    pos += m[0].length;
    return Number(m[0]);
  }

  const result = parseExpr();
  if (pos !== src.length) throw new Error(`位置 ${pos} 处有多余字符 "${src.slice(pos)}"`);
  return result;
}

function calculate(expression: string): string {
  try {
    return JSON.stringify({ result: evalExpr(expression) });
  } catch (e) {
    return JSON.stringify({ error: (e as Error).message });
  }
}

// 名字 -> 函数 的映射，模型报出名字，你在这里找到真身（同步/异步实现都收——调用方 await 兼容两者）
const TOOL_IMPL: Record<string, (args: any) => string | Promise<string>> = {
  get_weather: (args) => getWeather(args.city),
  calculate: (args) => calculate(args.expression),
};

// openai SDK 有严格的消息类型，这里先用 any[] 降低书写阻力；
// 想练类型的话可以换成 OpenAI.Chat.ChatCompletionMessageParam[]（Node 不做类型校验，纯自学用）
async function run(userQuestion: string): Promise<string> {
  // 完整的一轮 Function Calling：可能包含多次工具调用，直到模型给出最终回答。
  const messages: any[] = [{ role: "user", content: userQuestion }];

  // TODO 1：发起第一次请求
  //   调 client.chat.completions.create({ model: MODEL, messages, tools: TOOLS })
  //   思考：为什么还要传 tools: TOOLS？不传会怎样？
  // const response = null; // 替换这行
  async function request() {
    console.log('---------------');
    console.log(JSON.stringify(messages, null, 2));
    const response = await client.chat.completions.create({
      model: MODEL,
      messages,
      tools: [...TOOLS] // TOOLS 是 as const 的 readonly 字面量（教学保类型），SDK 参数要 mutable——展开复制一份
    });
    return response;
  }

  // TODO 2：处理模型返回的 tool_calls
  //   提示：response.choices[0].message 可能带 .tool_calls（是个数组，可能不止一个）
  //   对每一个 toolCall：
  //     a) 用 toolCall.function.name 在 TOOL_IMPL 里找到函数并执行，
  //        参数是 toolCall.function.arguments（一个 JSON 字符串，记得 JSON.parse）
  //     b) 关键一步：把模型的这条 assistant 消息（带 tool_calls 的完整 message 对象）
  //        push 进 messages；再把每个工具的执行结果作为
  //        { role: "tool", tool_call_id: toolCall.id, content: 结果字符串 } push 进去
  //   思考：如果忘了把 assistant 消息 push 进去，API 会报什么错？为什么？
  async function callFn(response: Awaited<ReturnType<typeof request>>) {
    console.log('++++++++++++++++');
    console.log(response.choices);
    console.log('++++++++++++++++');
    const message = response.choices[0].message;
    const toolCalls = message.tool_calls || [];
    if (toolCalls.length) {
      messages.push(message);
    }
    // openai SDK 的 tool_calls 是联合类型（function call / custom tool call 两种变体），
    // 这里只支持 function 变体——断言成窄类型（模块 3 同款处理）
    for (const toolCall of toolCalls as { id: string; function: { name: string; arguments: string } }[]) {
      const toolName = toolCall.function.name;
      const args = JSON.parse(toolCall.function.arguments);
      const result = await TOOL_IMPL[toolName](args);
      messages.push({ role: "tool", tool_call_id: toolCall.id, content: result });
    }
    return message;
  }

  // TODO 3：循环
  //   把上面 1、2 包进一个 while 循环：只要模型还在要工具调用，就继续；
  //   当返回的 message 只有 content 没有 tool_calls 时，循环结束，返回 message.content
  //   面试考点：这个 while 循环，就是模块 3 里 "Agent" 的雏形。
  //   （建议加个 maxSteps = 10 防手滑死循环，顺便提前踩掉模块 3 的一个考点）
  const maxSteps = 10;
  let steps = 0;
  while(true) {
    if (steps > maxSteps) {
      throw new Error("超过最大循环次数，可能是模型一直要求调用工具");
    }
    const response = await request();
    const message = await callFn(response);
    if (!message.tool_calls || message.tool_calls.length === 0) {
      return message.content ?? "";
    }
    steps++;
  }
}

// 依次测试：单工具、多工具、不用工具，观察行为差异
const QUESTIONS = [
  // '同时告诉我北京天气，并计算 3*7+2', // 会触发两个工具
  "北京今天天气怎么样？",
  // "北京天气如果是雨天，帮我算一下 (18+22)*15 等于多少，我要给 15 个人买伞，单价 18 元每人再加 22 元的配送费", // 会逼模型连续用两个工具
  // "你好，介绍一下你自己", // 应该完全不触发工具
];

for (const q of QUESTIONS) {
  console.log("=".repeat(60));
  console.log("用户：", q);
  console.log("助手：", await run(q));
}

// TODO 4（写完上面后做）：在 run() 里每次请求前 console.log(JSON.stringify(messages, null, 2))
//  亲眼看 messages 数组怎么一步步滚动——这是面试必考、也是最容易说不清的地方。
