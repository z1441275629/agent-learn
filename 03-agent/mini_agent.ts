// 模块 3：Agent —— 把 Function Calling 装进循环
//
// 和模块 1 的区别（面试杀手锏）：
//   模块 1 你写的是"一次问答里的工具调用"；这里是完整的 Agent：
//   工具注册表 + system prompt + 步数保护 + 多轮记忆。
//   Anthropic 对 Agent 的定义：工作流是写死的流程编排，Agent 是模型自主决定下一步。
//   你写的这个 while 循环就是这句话的代码版——每一步调用什么工具，由模型看着
//   工具返回的结果现场决定，不是你 if-else 排好的。
//
// 你的任务：TODO 1~4。写完让 Agent 完成这个任务：
//   "查北京天气 → 下雨才买伞 → 算总价"，第二步工具调用是否发生，取决于第一步的结果。
import 'dotenv/config'
import OpenAI from 'openai'

// GLM Coding Plan 套餐专用端点（按量付费改 https://open.bigmodel.cn/api/paas/v4）
const BASE_URL = 'https://open.bigmodel.cn/api/coding/paas/v4'
const MODEL = 'glm-4.6'

const apiKey = process.env.GLM_API_KEY
if (!apiKey) {
	console.error('没找到 GLM_API_KEY。请在 ai-agent-lab/.env 里配置')
	process.exit(1)
}
const client = new OpenAI({ apiKey, baseURL: BASE_URL })

// ---------- 工具注册表（给你写好的，不用动） ----------
// name -> { description, parameters, impl } 三件套集中管理。
// 面试考点：新增工具只需 registerTool 一行，Agent 循环零改动——这就是"注册表"的价值。
type ToolImpl = (args: any) => Promise<string>
type ToolDef = { description: string; parameters: object; impl: ToolImpl }
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

// ---------- TODO 1：从注册表生成 API 的 tools 参数 ----------
//   把 registry 里每个条目的 schema 拼成 openai SDK 要的数组：
//   [{ type: "function", function: { name, description, parameters } }, ...]
//   思考：为什么不手写 tools 数组，而要从 registry 现拼？（新增工具时两处维护会漂移）
function buildToolsParam(): any[] {
	// throw new Error("TODO 1：从注册表生成 tools 参数");
	const tools: any[] = []
	for (const [key, value] of registry.entries()) {
		tools.push({
			type: 'function',
			function: {
				name: key,
				description: value.description,
				parameters: value.parameters,
			},
		})
	}
	return tools
}

// ---------- TODO 2：执行一次工具调用（dispatch） ----------
//   1. 用 toolCall.function.name 查 registry；查不到就返回错误 JSON（别抛异常，
//      把"未注册的工具 xxx"喂回给模型，它会自己换方案——这是 Agent 的容错）
//   2. JSON.parse(toolCall.function.arguments)，解析失败同样返回错误 JSON
//   3. await impl(args) 执行，用 try/catch 包住，工具报错也返回错误 JSON
//   统一约定：永远返回字符串，永远不抛——错误是喂给模型的信息，不是崩掉的理由
async function dispatch(toolCall: any): Promise<string> {
	// throw new Error("TODO 2：实现 dispatch");
	const toolName = toolCall.function.name
	if (!registry.has(toolName)) {
		return JSON.stringify({ error: `未注册的工具 ${toolName}` })
	}
	const fn = registry.get(toolName)
	let args: any
	try {
		args = JSON.parse(toolCall.function.arguments)
	} catch (err: any) {
		return JSON.stringify({ error: '参数解析失败' + err?.message })
	}
	try {
		const res = await fn?.impl(args)
		return JSON.stringify(res)
	} catch (err: any) {
		return JSON.stringify({ error: '工具调用失败' + err?.message })
	}
}

// Agent 的人设和行为规则（给你写好的）。面试点：system 定行为，user 给输入。
const SYSTEM_PROMPT = `你是一个严谨的生活助理。需要事实信息或计算时调用工具，不要凭空编造；
拿到工具结果后基于结果回答；任务完成后用不超过三句话给出最终建议。`

// ---------- TODO 3（核心）：Agent 循环 ----------
//   模块 1 你写过这个循环，这次加上三样新东西：
//   a) maxSteps 步数保护：超过就返回"（达到最大步数，任务中止）"，别死循环烧钱
//   b) 每轮 console.log(`[step ${n}] 调用工具: ...`)——亲眼看 Agent 的决策轨迹
//   c) 循环结束后 messages 原样保留（多轮对话要复用，见 TODO 4）
//   流程：调模型（带 TODO 1 的 tools 参数）→ 无 tool_calls 就返回 content；
//   有 tool_calls：assistant 消息 push 一次，每个调用经 TODO 2 的结果逐条 push
async function agentLoop(messages: any[], maxSteps = 8): Promise<string> {
	// throw new Error("TODO 3：实现 Agent 循环");
	let step = 1

	const tools = buildToolsParam()
	while (true) {
		if (step > maxSteps) {
			return JSON.stringify({ error: '(达到最大步数，任务中止)' })
		}
		const response = await client.chat.completions.create({
			model: MODEL,
			messages,
			tools,
		})
		const message = response.choices[0].message
		if (!message.tool_calls || message.tool_calls.length === 0) {
      return message.content || JSON.stringify({ error: '模型未返回内容' })
		}
    console.log(`[step ${step}] 调用: ${message.tool_calls?.map((t: any) => `${t.function.name}(${t.function.arguments})`).join(', ')}`)
		messages.push(message)
		const promises = message.tool_calls.map(async (tool) => await dispatch(tool))
		const toolRes = await Promise.all(promises)
		toolRes.forEach((item, index) => {
      console.log(`[step ${step}] 工具结果: ${message.tool_calls?.[index].function.name} -> ${item}`)
			messages.push({ role: 'tool', tool_call_id: message.tool_calls?.[index].id, content: item })
		})
		step++
	}
}

// 启动一个新任务（给你写好的）
async function runAgent(task: string, maxSteps = 8) {
	const messages = [
		{ role: 'system', content: SYSTEM_PROMPT },
		{ role: 'user', content: task },
	]
	const answer = await agentLoop(messages, maxSteps)
	return { answer, messages }
}

// ---------- 主流程 ----------
const { answer, messages } = await runAgent('北京今天会下雨吗？如果会下雨，我给全家 5 口人每人买一把 25 元的伞，帮我算算一共多少钱。')
console.log('\n=== 最终回答 ===\n' + answer)

// TODO 4：多轮记忆测试（解开注释）
//   往同一个 messages 数组里追加追问，再跑一次 agentLoop。
//   观察：模型是否不再调用工具、直接从历史里算出答案？
//   面试考点：messages 数组就是 Agent 的"记忆"——所谓多轮对话，就是把同一个
//   数组反复喂回去。没有它的 Agent 是金鱼，有它的 Agent 才能接着聊。
const followUp = '我刚才那笔买伞的钱具体是怎么算出来的？'
messages.push({ role: 'user', content: followUp })
const answer2 = await agentLoop(messages)
console.log('\n=== 追问回答 ===\n' + answer2)
