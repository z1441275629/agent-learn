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
const BUDGET_TOKENS = 1000

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

// 注册一个 search_notes，返回一段几千 token 的假搜索结果（模拟真实 RAG/网页抓取的返回量），再跑几轮追问
// registerTool('search_notes', {
// 	description: '搜索相关笔记',
// 	parameters: {
// 		type: 'object',
// 		properties: {
// 			query: { type: 'string', description: '搜索关键词' },
// 			maxResultTokens: { type: 'number', description: '返回的最大 token 数量', default: 1000 },
// 		},
// 		required: ['query'],
// 	},
// 	impl: async (args) =>
// 		truncateToolResult(
// 			JSON.stringify({ results: Array.from({ length: 100 }, (_, i) => (i === 50 ? '笔记51：重要！家里已经有 3 把伞了，不用再买' : `笔记${i + 1}：关于${args.query}的记录`)) }),
// 			args.maxResultTokens,
// 		),
// })

registerTool('search_notes', {
	description: '搜索相关笔记',
	parameters: {
		type: 'object',
		properties: {
			query: { type: 'string', description: '搜索关键词' },
		},
		required: ['query'],
	},
	impl: async (args) => JSON.stringify({ results: Array.from({ length: 100 }, (_, i) => (i === 50 ? '笔记51：重要！家里已经有 3 把伞了，不用再买' : `笔记${i + 1}：关于${args.query}的记录`)) }),
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

// 工具可能返回的内容太多，导致上下本超标，做一个截取工具返回值大小裁剪的函数，避免模型报错。这里简单截取前 1000 个字符，实际可根据需求调整。
// 头尾保留，中间省略，并标明省略了多少tokens。注意：这里的 maxTokens 是字符数，不是实际的 token 数量，实际使用中可能需要更精确的 token 计算。
function truncateToolResult(result: string, maxTokens: number = 300): string {
	const headCount = Math.floor(maxTokens / 3)
	const tailCount = Math.floor(maxTokens / 3)
	const originTokens = estimateTokens(result)
	if (originTokens > maxTokens) {
		return result.substring(0, headCount) + `....[已截断，原始 ${originTokens} tokens]...` + result.substring(result.length - tailCount)
	}
	return result
}

// Agent 的人设和行为规则（给你写好的）。面试点：system 定行为，user 给输入。
const SYSTEM_PROMPT = `你是一个严谨的生活助理。用户问相关问题时，需要先搜索相关笔记。需要事实信息或计算时调用工具，不要凭空编造；
拿到工具结果后基于结果回答；任务完成后用不超过三句话给出最终建议。`

// 本地粗估。
// 中文和英文的 token 密度不同，先用一个简单启发式（比如中文字符按 1 token/字、英文按 4 字符/token），
// 然后用 API 返回的真实用量校准它——你每次调用的 response.usage.prompt_tokens 就是标准答案，算出你的估算系数偏多少。
function estimateTokens(text: string): number {
	return (text || '').replace(/[^\x00-\xff]/g, 'xxxx').length / 4
}

// 把一次请求的上下文拆成 4 个桶打表——system / 对话历史 / 工具定义 / 工具结果
// 各自估多少 token、占百分之几。
function logContextBreakdown(messages: any[], tools: any[]) {
	const { systemTokens, historyTokens, toolsDefTokens, toolsResTokens, totalTokens } = getContextTokens(messages, tools)
	console.log('Context Breakdown:')
	console.log(`  System: ${systemTokens} tokens (${((systemTokens / totalTokens) * 100).toFixed(2)}%)`)
	console.log(`  History: ${historyTokens} tokens (${((historyTokens / totalTokens) * 100).toFixed(2)}%)`)
	console.log(`  Tools Definition: ${toolsDefTokens} tokens (${((toolsDefTokens / totalTokens) * 100).toFixed(2)}%)`)
	console.log(`  Tools Results: ${toolsResTokens} tokens (${((toolsResTokens / totalTokens) * 100).toFixed(2)}%)`)
	console.log(`  Total: ${totalTokens} tokens`)
}

function getContextTokens(messages: any[], tools: any[]): { systemTokens: number; historyTokens: number; toolsDefTokens: number; toolsResTokens: number; totalTokens: number } {
	const system = messages.find((m) => m.role === 'system')?.content || ''
	// 对话历史：user + assistant 消息，以及assistant消息里带的tool_calls（函数名+参数）——这些都是模型需要看到的上下文
	const history = messages
		.filter((m) => ['user', 'assistant'].includes(m.role))
		.map((m) => (m.content || '') + (m.tool_calls?.map((t: any) => `${t.function.name}(${t.function.arguments})`).join('') || ''))
		.join('\n')
	const toolsDef = JSON.stringify(tools)
	const toolsRes = messages
		.filter((m) => m.role === 'tool')
		.map((m) => m.content || '')
		.join('\n')

	const systemTokens = estimateTokens(system)
	const historyTokens = estimateTokens(history)
	const toolsDefTokens = estimateTokens(toolsDef)
	const toolsResTokens = estimateTokens(toolsRes)

	const totalTokens = systemTokens + historyTokens + toolsDefTokens + toolsResTokens

	return {
		systemTokens,
		historyTokens,
		toolsDefTokens,
		toolsResTokens,
		totalTokens,
	}
}

function getMessagesTokens(messages: any[]): number {
	return messages.reduce((sum, m) => {
		const toolCallsTokens = m.tool_calls ? m.tool_calls.reduce((toolSum, t) => toolSum + estimateTokens(`${t.function.name}(${t.function.arguments})`), 0) : 0
		return sum + estimateTokens(m.content) + toolCallsTokens
	}, 0)
}

const tools = buildToolsParam()

// system 恒留、从最新往回装、超预算的旧消息丢弃；
// 边界不许拆散 assistant(tool_calls)/tool 配对（拆了 API 报 400）；
// 实验记录开窗 vs 不开的每步成本 + 追问质量。
function applyWindow(messages: any[], budgetTokens: number = 1000): any[] {
	const { totalTokens, toolsDefTokens } = getContextTokens(messages, tools)
	if (totalTokens <= budgetTokens) {
		return messages
	}
	const systemMessage = messages.find((m) => m.role === 'system')

	// 从最新的消息开始，逐步添加到窗口中，直到达到预算限制
	const windowedMessages: any[] = []
	let currentTokens = toolsDefTokens // 先算上工具定义的 token，因为它们是每次请求都必须的

	// 保留 system 消息
	if (systemMessage) {
		windowedMessages.push(systemMessage)
		currentTokens += estimateTokens(systemMessage.content)
	}

	const turns = groupTurns(messages)
	// 从后往前遍历轮次，保留最近的 retainRounds 轮对话
	for (let i = turns.length - 1; i >= 0; i--) {
		if (currentTokens >= budgetTokens) {
			break
		}
		// const turnMessages = turns[i].messages
		// const turnTokens = getMessagesTokens(turnMessages)
		// if (currentTokens + turnTokens <= budgetTokens) {
		// 	windowedMessages.splice(1, 0, ...turnMessages) // 插入到 system 消息之后
		// 	currentTokens += turnTokens
		// } else {
		// 	console.warn(`轮次消息超预算，无法保留。当前token:${currentTokens}, 预算：${budgetTokens}`)
		// 	break
		// }
	}

	for (let i = messages.length - 1; i >= 0; i--) {
		if (currentTokens >= budgetTokens) {
			break
		}
		const message = messages[i]
		if (message.role === 'system') continue // 已经保留了 system 消息
		if (message.role === 'tool') {
			// 保证 tool 消息和对应的 assistant 消息成对出现
			const correspondingAssistantIndex = messages.findIndex((m) => m.role === 'assistant' && m.tool_calls?.some((t: any) => t.id === message.tool_call_id))
			const correspondingMessages = messages.slice(correspondingAssistantIndex, i + 1)
			// console.log('correspondingMessages', correspondingMessages)
			const correspondingTokens = getMessagesTokens(correspondingMessages)
			windowedMessages.splice(1, 0, ...correspondingMessages)
			i = correspondingAssistantIndex // 跳过已经添加的 assistant 消息
			currentTokens += correspondingTokens

			if (currentTokens >= budgetTokens) {
				console.warn(`assistant/tool 配对消息超预算，但是无法拆散，仍然保留了它们。当前token:${currentTokens}, 预算：${budgetTokens}`)
			}
		} else {
			const messageTokens = estimateTokens(message.content)
			windowedMessages.splice(1, 0, message) // 插入到 system 消息之后
			currentTokens += messageTokens
		}
	}

	// user 消息必须保留至少一条，否则模型会报错（没有 user 消息，模型不知道你在问什么）
	if (!windowedMessages.some((m) => m.role === 'user')) {
		console.log('applyWindow: 没有 user 消息，保留最后一条 user 消息')
		const lastUserMessage = messages.findLast((m) => m.role === 'user')
		if (lastUserMessage) {
			windowedMessages.splice(1, 0, lastUserMessage)
			currentTokens += estimateTokens(lastUserMessage.content)
		}
	}

	console.log(`applyWindow: 原始消息 ${messages.length} 条，窗口消息 ${windowedMessages.length} 条，预算 ${budgetTokens} tokens，实际 ${currentTokens} tokens`)
	// console.log(
	// 	'窗口消息内容：',
	// 	JSON.stringify(
	// 		windowedMessages.map((m) => ({ role: m.role, content: m.content })),
	// 		null,
	// 		2,
	// 	),
	// )
	return windowedMessages
}

// 把旧消息换成一段摘要，近期轮次原样保留
async function summarizeMessages(messagesToSummarize: any[]): Promise<any> {
	const systemPrompt = { role: 'system', content: '把以下对话压缩成摘要，必须保留：任务目标、已做出的决定及依据、关键数字、未完成事项' }
	// const { messagesToSummarize } = analyzeMessages(messages, 1000)
	const response = await client.chat.completions.create({
		model: MODEL,
		// 滑动窗口上下文
		messages: [systemPrompt, ...messagesToSummarize],
		tools: [],
	})
	const summarizedMessage = response.choices[0].message
	console.log(`成本比对 压缩前: ${getMessagesTokens(messagesToSummarize)}, 压缩后: ${estimateTokens(summarizedMessage.content || '')}`)
	// 这个角色用啥都行???
	return { role: 'system', content: summarizedMessage.content }
}

// 获取需要压缩的就消息，assistant/tool 配对消息不拆散，保留最近的 n? 轮对话，其他的都压缩成摘要
function analyzeMessages(messages: any[], budgetTokens = 1000): { systemMessage: any; retainedMessages: any[]; messagesToSummarize: any[] } {
	const turns = groupTurns(messages)
	const systemMessage = messages.find((m) => m.role === 'system')
	const retainedMessages: any[] = []
	const messagesToSummarize: any[] = []

	// 从后往前遍历，保留最近的 n 轮对话, 轮数看token占用情况
	// let currentTokens = systemMessage ? estimateTokens(systemMessage.content) : 0
	let currentTokens = 0
	const halfBudgetTokens = budgetTokens / 2
	for (let i = turns.length - 1; i >= 0; i--) {
		const turnMessages = turns[i].messages
		const turnTokens = getMessagesTokens(turnMessages)
		if (currentTokens + turnTokens <= halfBudgetTokens) {
			retainedMessages.unshift(...turnMessages)
			currentTokens += turnTokens
		} else {
			if (!retainedMessages.length) {
				console.log(`最后一轮消息也超预算了，仍然保留了它们。当前token:${currentTokens + turnTokens}, 预算：${halfBudgetTokens}`)
				messagesToSummarize.unshift(...turnMessages)
				currentTokens += turnTokens
			} else {
				messagesToSummarize.unshift(...turnMessages)
			}
		}
	}

	return { systemMessage, retainedMessages, messagesToSummarize }
}

type Turn = { messages: any[] }
// 把消息按轮分组[用户开始问到后面的回答]
function groupTurns(messages: any[]): Turn[] {
	const turns: Turn[] = []
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i]
		if (message.role === 'user') {
			const turnItem: Turn = { messages: [] }
			turnItem.messages.push(message)
			turns.push(turnItem)
		} else {
			// 如果system消息后面不是user消息，直接丢弃
			turns[turns.length - 1] && turns[turns.length - 1].messages.push(message)
		}
	}
	return turns
}

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

	// const tools = buildToolsParam()
	while (true) {
		if (step > maxSteps) {
			return JSON.stringify({ error: '(达到最大步数，任务中止)' })
		}
		if (getContextTokens(messages, tools).totalTokens > BUDGET_TOKENS) {
			const { systemMessage, retainedMessages, messagesToSummarize } = analyzeMessages(messages, BUDGET_TOKENS)
			const summarizedMessage = await summarizeMessages(messagesToSummarize)
			messages = [systemMessage, summarizedMessage, ...retainedMessages].filter(Boolean)
			console.log(
				`压缩后的消息: ${JSON.stringify(
					messages.map((m) => ({ role: m.role, content: m.content })),
					null,
					2,
				)}`,
			)
		}

		logContextBreakdown(messages, tools)
		const response = await client.chat.completions.create({
			model: MODEL,
			// 滑动窗口上下文
			// messages: applyWindow(messages, 1000), // 1k token 上下文窗口
			messages,
			tools,
		})
		console.log('真实token用量：', response.usage?.prompt_tokens)
		const message = response.choices[0].message
		if (!message.tool_calls?.length) {
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
const { answer, messages } = await runAgent('北京今天会下雨吗？如果会下雨，我给全家 5 口人每人买一把 25 元的伞，帮我算算一共多少钱。查一下我笔记里关于买伞的记录，再结合北京天气决定买不买')
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

const followUp2 = '北京明天的天气怎么样，我明天需要带伞吗'
messages.push({ role: 'user', content: followUp2 })
const answer3 = await agentLoop(messages)
console.log('\n=== 追问其他问题回答 ===\n' + answer3)
