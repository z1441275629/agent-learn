// 模块 06：上下文工程 —— 给 mini_agent 装上 ContextManager
//
// 本文件只负责 Agent 本体：工具注册表 + dispatch + 循环 + 主流程。
// 上下文的四件武器（测量/截断/压缩/窗口）全部在 ./context.ts 的 ContextManager 里：
//   双账本：ledger 完整历史（存储），view 发送视图（压缩/开窗只动它）。
//   循环里的约定：每步先 ctx.ensureBudget()，再 ctx.getSendView() 发给 API；
//   新消息一律 ctx.add()（双写）——不直接 push 任何数组。
import 'dotenv/config'
import OpenAI from 'openai'
import { ContextManager, truncateToolResult } from './context.ts'

// GLM Coding Plan 套餐专用端点（按量付费改 https://open.bigmodel.cn/api/paas/v4）
const BASE_URL = 'https://open.bigmodel.cn/api/coding/paas/v4'
const MODEL = 'glm-4.6'
const BUDGET_TOKENS = 600

const apiKey = process.env.GLM_API_KEY
if (!apiKey) {
	console.error('没找到 GLM_API_KEY。请在 ai-agent-lab/.env 里配置')
	process.exit(1)
}
const client = new OpenAI({ apiKey, baseURL: BASE_URL })

// ---------- 工具注册表 ----------
// name -> { description, parameters, impl, maxResultTokens? } 集中管理。
// maxResultTokens：工具级截断配置（武器①的口径）——大返回量的工具必须设，
// 小工具不设就不截。不设全局默认值，逼自己想清楚每个工具的返回量级。
type ToolImpl = (args: any) => Promise<string>
type ToolDef = { description: string; parameters: object; impl: ToolImpl; maxResultTokens?: number }
const registry = new Map<string, ToolDef>()

function registerTool(name: string, def: ToolDef) {
	registry.set(name, def)
}

// 内置工具：天气（假数据，固定小雨，保证演示路径稳定）
registerTool('get_weather', {
	description: '查询某个城市当前的天气情况',
	parameters: {
		type: 'object',
		properties: { city: { type: 'string', description: '城市名，如：北京' } },
		required: ['city'],
	},
	impl: async (args) => JSON.stringify({ city: args.city, weather: '小雨', tempC: 18 }),
})

// 内置工具：算总价
registerTool('calculate_total', {
	description: '计算总价：数量 × 单价',
	parameters: {
		type: 'object',
		properties: {
			quantity: { type: 'number', description: '数量' },
			unit_price: { type: 'number', description: '单价（元）' },
		},
		required: ['quantity', 'unit_price'],
	},
	impl: async (args) => JSON.stringify({ total: args.quantity * args.unit_price }),
})

// 污染源工具：模拟真实 RAG/网页抓取的返回量级。
// 金笔记实验：第 51 条埋了决定性信息「家里已有 3 把伞」——它落在截断区里，
// 用来亲眼验证「截断省 token 但砍信息」：agent 大概率看不到它，照样建议买伞。
registerTool('search_notes', {
	description: '当用户提到笔记、个人记录、或需要引用用户过往记录时调用；输入搜索关键词，返回相关笔记列表',
	parameters: {
		type: 'object',
		properties: { query: { type: 'string', description: '搜索关键词' } },
		required: ['query'],
	},
	maxResultTokens: 300,
	impl: async (args) => JSON.stringify({ results: Array.from({ length: 100 }, (_, i) => (i === 50 ? '笔记51：重要！家里已经有 3 把伞了，不用再买' : `笔记${i + 1}：关于${args.query}的记录`)) }),
})

// 从注册表生成 API 的 tools 参数（新增工具零改动）
function buildToolsParam(): any[] {
	const tools: any[] = []
	for (const [key, value] of registry.entries()) {
		tools.push({ type: 'function', function: { name: key, description: value.description, parameters: value.parameters } })
	}
	return tools
}

// ---------- dispatch：执行一次工具调用，武器①（截断）在这里接线 ----------
// 统一约定：永远返回字符串，永远不抛——错误是喂给模型的信息，不是崩掉的理由
async function dispatch(toolCall: any): Promise<string> {
	const toolName = toolCall.function.name
	const def = registry.get(toolName)
	if (!def) {
		return JSON.stringify({ error: `未注册的工具 ${toolName}` })
	}
	let args: any
	try {
		args = JSON.parse(toolCall.function.arguments)
	} catch (err: any) {
		return JSON.stringify({ error: '参数解析失败' + err?.message })
	}
	try {
		const res = await def.impl(args)
		const raw = JSON.stringify(res)
		// 源头减量：结果进 messages 之前就砍，别等超预算再救
		return def.maxResultTokens ? truncateToolResult(raw, def.maxResultTokens) : raw
	} catch (err: any) {
		return JSON.stringify({ error: '工具调用失败' + err?.message })
	}
}

// Agent 的人设和行为规则。面试点：system 定行为，user 给输入。
const SYSTEM_PROMPT = `你是一个严谨的生活助理。用户问相关问题时，需要先搜索相关笔记。需要事实信息或计算时调用工具，不要凭空编造；
拿到工具结果后基于结果回答；任务完成后用不超过三句话给出最终建议。`

// ---------- Agent 循环 ----------
// 和模块 3 的唯一区别：messages 数组的生杀大权交给 ContextManager。
// 每步：ensureBudget（可能触发一次压缩调用）→ 打表 → 用 view 发请求 → 新消息 ctx.add 双写
async function agentLoop(ctx: ContextManager, maxSteps = 8): Promise<string> {
	let step = 1
	const tools = buildToolsParam()

	while (true) {
		if (step > maxSteps) {
			return JSON.stringify({ error: '(达到最大步数，任务中止)' })
		}
		await ctx.ensureBudget()
		ctx.logBreakdown()
		const response = await client.chat.completions.create({
			model: MODEL,
			messages: ctx.getSendView(),
			tools,
		})
		console.log('真实token用量：', response.usage?.prompt_tokens)
		const message = response.choices[0].message
		const toolCalls = (message.tool_calls ?? []) as any[]
		if (!toolCalls.length) {
			return message.content || JSON.stringify({ error: '模型未返回内容' })
		}
		console.log(`[step ${step}] 调用: ${toolCalls.map((t) => `${t.function.name}(${t.function.arguments})`).join(', ')}`)
		ctx.add(message)
		const toolRes = await Promise.all(toolCalls.map(async (tool) => await dispatch(tool)))
		toolRes.forEach((item, index) => {
			console.log(`[step ${step}] 工具结果: ${toolCalls[index].function.name} -> ${item}`)
			ctx.add({ role: 'tool', tool_call_id: toolCalls[index].id, content: item })
		})
		step++
	}
}

// 启动一个新任务
function createAgent(task: string): ContextManager {
	const ctx = new ContextManager(client, MODEL, { budgetTokens: BUDGET_TOKENS, toolsDef: buildToolsParam() })
	ctx.add({ role: 'system', content: SYSTEM_PROMPT })
	ctx.add({ role: 'user', content: task })
	return ctx
}

// ---------- 主流程 ----------
const ctx = createAgent('北京今天会下雨吗？如果会下雨，我给全家 5 口人每人买一把 25 元的伞，帮我算算一共多少钱。查一下我笔记里关于买伞的记录，再结合北京天气决定买不买')
const answer = await agentLoop(ctx)
console.log('\n=== 最终回答 ===\n' + answer)

// 多轮追问：同一个 ctx 接着用——底账在，历史就跟着走（模块 3 的金鱼测试升级版）
ctx.add({ role: 'user', content: '我刚才那笔买伞的钱具体是怎么算出来的？' })
const answer2 = await agentLoop(ctx)
console.log('\n=== 追问回答 ===\n' + answer2)

ctx.add({ role: 'user', content: '北京明天的天气怎么样，我明天需要带伞吗' })
const answer3 = await agentLoop(ctx)
console.log('\n=== 追问其他问题回答 ===\n' + answer3)

console.log('\n=== 最终统计 ===', ctx.stats)
