// 通用 LLM 配置层（生产/Agent 链共享）：把「平台相关的四样」抽到 .env，代码不绑死任何平台徽标。
// 建它原因：一次性 GLM（Coding plan 到期）→ 换火山 ARK（新 Coding plan）→ 可能还有下次——
// 只要 baseURL/model/key 还在代码常量里，换平台就得改代码；抽进 .env 后换平台只改配置。
//
// 平台口径（OpenAI 兼容协议——模块 0 就立过的事实标准）：
//   LLM_BASE_URL       聊天端点（GLM: /api/coding/paas/v4 | 火山 ARK: /api/v3 | 其他 OpenAI 兼容平台同理）
//   LLM_MODEL          聊天模型名（glm-5.3 | doubao-...）
//   LLM_API_KEY        .env 里的真实 key（源码永不出现 key——它在 gitignored .env，diff 永不含真值）
//   LLM_BUDGET_TOKENS  上下文预算（可选，默认 6000）
//   LLM_EMBED_BASE_URL    embedding 端点（默认 GLM 按量端点；Coding Plan 只包聊天模型，embedding 走标量计费 /api/paas/v4）
//   LLM_EMBED_MODEL       embedding 模型名（GLM: embedding-3 | 火山: doubao-embedding... | 硅基: BAAI/bge-large-zh-v1.5）
//   LLM_EMBED_API_KEY     embedding 的 key（**可选**——同平台时省略，回落用 LLM_API_KEY；
//                        分别平台时填它的 key，如 chat 用火山、embed 用硅基流动的免费 bge）
//
// client（聊天）+ embedClient（embedding）两个 OpenAI 兼容客户端都在这建——「LLM 客户端」唯一事实源，
// 换平台只改 .env。key 默认共用 LLM_API_KEY；embed 想挂别的平台（如免费 embed 服务）用 LLM_EMBED_API_KEY 覆盖。
//
// 退化策略：平台服务商的下游 SDK 用 `OpenAI` 兼容客户端，baseURL+key+model 三件套拿到手，
// OpenAI 兼容 endpoints 就能起——这就是「事实标准」的兜底。
import 'dotenv/config'
import OpenAI from 'openai'

// 从环境变量读配置，缺了就报清楚缺哪个（fail-fast，别让一个空值炸在深层调用让人海底捞）
const BASE_URL = process.env.LLM_BASE_URL || ''
const MODEL = process.env.LLM_MODEL || ''
const apiKey = process.env.LLM_API_KEY || ''
const BUDGET_TOKENS = Number(process.env.LLM_BUDGET_TOKENS || 6000)
const EMBED_BASE_URL = process.env.LLM_EMBED_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4'
const EMBED_MODEL = process.env.LLM_EMBED_MODEL || 'embedding-3'
// embed 的 key 可选：同平台省略回落 LLM_API_KEY；挂独立平台（免费 embed）填它自己的 key
const embedKey = process.env.LLM_EMBED_API_KEY || apiKey
// §7 大小模型路由的「小」档（模块 11）：判断题/转写类浅窗口走便宜模型——同 embed 的模式，
// 按量端点 + 可选独立 key（缺 LLM_LIGHT_MODEL = 没配小档，调用点自动回落主模型，产线照常跑）
const LIGHT_BASE_URL = process.env.LLM_LIGHT_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4'
const LIGHT_MODEL = process.env.LLM_LIGHT_MODEL || ''
const lightKey = process.env.LLM_LIGHT_API_KEY || apiKey
// thinking 协议标识：模型怎么表达思考开关——换模型只改这一个值，agent 翻译层读它
//   openapi → 火山/GLM/DeepSeek 风格：{ thinking: { type: enabled|disabled } } + reasoning_effort
//   bool    → 某些 OpenAI 兼容模型：thinking: true|false（单布尔）
//   none    → 不支持思考参数（就别传，省得撞 400）
export type ThinkingStyle = 'openapi' | 'bool' | 'none'
const THINKING_STYLE = (process.env.LLM_THINKING_STYLE ?? 'openapi') as ThinkingStyle
export { THINKING_STYLE }

const missing: string[] = []
if (!BASE_URL) missing.push('LLM_BASE_URL')
if (!MODEL) missing.push('LLM_MODEL')
if (!apiKey) missing.push('LLM_API_KEY')
if (missing.length) {
	console.error(`缺 LLM 配置：${missing.join(' / ')}。在 ai-agent-lab/.env 里配置（参考 .env.example）`)
	process.exit(1)
}

const client = new OpenAI({ apiKey, baseURL: BASE_URL! })
const embedClient = new OpenAI({ apiKey: embedKey, baseURL: EMBED_BASE_URL })
// 小档客户端只在配了 LLM_LIGHT_MODEL 才建（null = 未配置，路由层据此回落主模型）
export const lightClient = LIGHT_MODEL ? new OpenAI({ apiKey: lightKey, baseURL: LIGHT_BASE_URL }) : null
export { client, embedClient }
export { MODEL, BUDGET_TOKENS, EMBED_MODEL, LIGHT_MODEL }