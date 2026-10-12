// 模块 0 冒烟测试：验证 API key 和网络都通。跑通这个再开始模块 1。
import "dotenv/config";
import OpenAI from "openai";

// OpenAI 兼容协议是事实标准：换厂商只需改这两个常量
// GLM Coding Plan 套餐专用端点；如果你买的是按量付费 API 额度，改成 https://open.bigmodel.cn/api/paas/v4
const BASE_URL = "https://open.bigmodel.cn/api/coding/paas/v4";
const MODEL = "glm-4.6"; // 也可试 glm-4.5-air（更省）、glm-4.7（更强）

const apiKey = process.env.GLM_API_KEY;
if (!apiKey) {
  console.error("没找到 GLM_API_KEY。请在 ai-agent-lab/.env 里写入一行：GLM_API_KEY=你的key");
  process.exit(1);
}

const client = new OpenAI({ apiKey, baseURL: BASE_URL });

const resp = await client.chat.completions.create({
  model: MODEL,
  messages: [{ role: "user", content: "用一句话介绍你自己，并说明你是什么模型。" }],
});

console.log("模型回复：", resp.choices[0].message.content);
console.log("本次消耗 token —— 输入:", resp.usage?.prompt_tokens, "输出:", resp.usage?.completion_tokens);
