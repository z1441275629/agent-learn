// 模块 07：记忆 —— 给 mini_agent 装上跨会话长期记忆
//
// 本文件只负责 Agent 本体：dispatch + 循环 + 主流程。
// 工具定义在 ./tools.ts（内置）和 ./memory.ts（记忆工具，启动时注册进来）；
// 上下文的四件武器（测量/截断/压缩/窗口）全部在 ./context.ts 的 ContextManager 里：
//   双账本：ledger 完整历史（存储），view 发送视图（压缩/开窗只动它）。
//   循环里的约定：每步先 ctx.ensureBudget()，再 ctx.getSendView() 发给 API；
//   新消息一律 ctx.add()（双写）——不直接 push 任何数组。
import 'dotenv/config'
import OpenAI from 'openai'
import { pathToFileURL } from 'node:url'
import { ContextManager, truncateToolResult } from './context.ts'
import { MemoryManager, registerMergeStrategy, writeMemoryTool } from './memory.ts'
import { registry, buildToolsParam } from './tools.ts'
import type { WriteMemoryItem } from './type.ts' // WriteMemoryItem 暂未用：extractMemories 改用 parseModelJson 推断后留作扩展
// import { historyMemoryToVector } from './vector_store.ts'

// GLM Coding Plan 套餐专用端点（按量付费改 https://open.bigmodel.cn/api/paas/v4）
const BASE_URL = 'https://open.bigmodel.cn/api/coding/paas/v4'
const MODEL = 'glm-5.3'
export const BUDGET_TOKENS = 6000

const apiKey = process.env.GLM_API_KEY
if (!apiKey) {
	console.error('没找到 GLM_API_KEY。请在 ai-agent-lab/.env 里配置')
	process.exit(1)
}
const client = new OpenAI({ apiKey, baseURL: BASE_URL })

// ---------- 工具注册 ----------
// 内置工具在 ./tools.ts 里定义并注册（import 时完成）；记忆工具来自 ./memory.ts，
// 启动时注册一次——注册是启动动作，不放在 buildToolsParam 里每次循环重复做
// ---------- 写入策略开关（A/B 对比实验） ----------
// A = 模型自主（write_memory 满血 description + 提示词写入引导）
// B = 会话结束钩子抽取（不注册 write_memory，模型看不到它——条件才干净）
// AB = 两个都开（默认）
// 用法：WRITE_STRATEGY=B node 07-memory/mini_agent.ts 2
const WRITE_STRATEGY = (process.env.WRITE_STRATEGY ?? 'AB').toUpperCase() as 'A' | 'B' | 'AB'

console.info('本次策略是：' + WRITE_STRATEGY)
MemoryManager.registerMemoryTools(registry, WRITE_STRATEGY)

// 注册记忆合并策略：查重命中后的"并集合并"由 LLM 做（事实合并不适合纯字符串拼接）。
// memory.ts 不 import 本文件的 client（会循环依赖）——需要 LLM 的策略由这里注入
registerMergeStrategy(async (oldM, newM) => {
	const response = await client.chat.completions.create({
		model: MODEL,
		messages: [
			{
				role: 'system',
				content:
					'你是记忆治理模块，负责把同一用户的两条相似记忆合并成一条。规则：①事实取并集，旧记忆里的事实一条不能丢 ②同一事实冲突时以新记忆为准（用户后说的覆盖先说的，如日期修正） ③去掉重复表述，不编造没提到的事实 ④同一事实措辞以旧记忆为准，除非新记忆更正了事实——重复合并时新表述每轮都获胜会让用词慢慢漂移 ⑤时间一律写绝对日期（如2026年3月1日） ⑥输出纯 JSON {"content":"合并后的正文","abstract":"不超过30字的摘要"}，不要 markdown 代码块',
			},
			{ role: 'user', content: JSON.stringify({ 旧记忆: oldM, 新记忆: newM }) },
		],
		tools: [],
	})
	const merged = parseModelJson(response.choices[0].message?.content)
	if (!merged?.content) throw new Error('合并结果缺 content 或不是合法 JSON')
	return merged
})

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
// onToolCall：可选观察者（回归测试用），每次工具调用完成后上报 name/arguments/result——
// 不影响循环本身，测试借此捕获工具调用序列
export type ToolCallObserver = (info: { name: string; arguments: string; result: string }) => void

export async function agentLoop(ctx: ContextManager, maxSteps = 8, onToolCall?: ToolCallObserver): Promise<string> {
	let step = 1
	const tools = buildToolsParam()

	while (true) {
		if (step > maxSteps) {
			// 这里不阻塞执行，后面可以改成钩子
			if (WRITE_STRATEGY !== 'A') extractMemories(ctx)
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
		ctx.add(message)
		if (!toolCalls.length) {
			// 这里不阻塞执行，后面可以改成钩子
			if (WRITE_STRATEGY !== 'A') extractMemories(ctx)
			return message.content || JSON.stringify({ error: '模型未返回内容' })
		}
		console.log(`[step ${step}] 调用: ${toolCalls.map((t) => `${t.function.name}(${t.function.arguments})`).join(', ')}`)
		const toolRes = await Promise.all(toolCalls.map(async (tool) => await dispatch(tool)))
		toolRes.forEach((item, index) => {
			console.log(`[step ${step}] 工具结果: ${toolCalls[index].function.name} -> ${item}`)
			ctx.add({ role: 'tool', tool_call_id: toolCalls[index].id, content: item })
		})
		onToolCall && toolCalls.forEach((tc, index) => onToolCall({ name: tc.function.name, arguments: tc.function.arguments, result: toolRes[index] }))
		step++
	}
}

// 启动一个新任务（budgetTokens 可覆盖——回归测试的低预算场景用；默认模块级 BUDGET_TOKENS）
export async function createAgent(task: string, opts?: { budgetTokens?: number }): Promise<ContextManager> {
	const ctx = new ContextManager(client, MODEL, { budgetTokens: opts?.budgetTokens ?? BUDGET_TOKENS, toolsDef: buildToolsParam() })
	const memoryPrompt = await MemoryManager.getSystemPrompt(WRITE_STRATEGY !== 'B')
	// 清洗历史数据，执行过一次就好了
	// await historyMemoryToVector()
	ctx.add({ role: 'system', content: SYSTEM_PROMPT + `记忆：${memoryPrompt}` })
	ctx.add({ role: 'user', content: task })
	return ctx
}

// 模型输出的 JSON 永远不可信：哪怕提示词写了"纯 JSON"，它还是可能包一层 ```json 围栏。
// 先剥围栏再 parse；剥完还不合法返回 undefined，由调用方大声报错走兜底
function parseModelJson(raw: string | null | undefined): any {
	if (!raw) return undefined
	let text = raw.trim()
	if (text.startsWith('```')) {
		text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
	}
	try {
		return JSON.parse(text)
	} catch {
		return undefined
	}
}

export async function extractMemories(ctx: ContextManager) {
	// 这个函数在 agentLoop 里是不 await 的（不阻塞最终回答）——
	// 里面任何异常逃逸都会变成 unhandled rejection 直接崩进程，钩子必须自己消化错误
	try {
		const history = ctx.ledger.filter((item) => item.role !== 'system')
		const userPrompt =
			'从以下对话中抽取关于用户的持久事实与偏好，以 JSON 数组返回 [{name, content, abstract}]，没有可抽取的就返回 []， 注意是纯json，不要用markdown代码块包裹。' +
			'只记录对话中出现的事实，不要补充建议、推断或常识；时间一律写成绝对日期（如2026年3月1日，今天是2026年），不要用"今年""最近几个月"这类相对表述；abstract 不超过30字。会话：' +
			JSON.stringify(history)
		const response = await client.chat.completions.create({
			model: MODEL,
			messages: [
				{
					role: 'system',
					content: '当了解到关于用户的持久事实或偏好时调用——判断标准：这条信息在未来的对话中还用得上吗？（如：年龄、职业、家庭构成、所在地、作息习惯、表达偏好、长期目标）。一次性的任务细节不要记。',
				},
				{ role: 'user', content: userPrompt },
			],
			tools: [],
		})
		console.log('抽取调用真实token：', response.usage?.prompt_tokens)
		const message = response.choices[0].message
		console.log(`模型提取的记忆信息：${message.content}`)

		// 写入记忆
		const toMemories = parseModelJson(message?.content)
		if (toMemories === undefined) {
			// 静默丢记忆比崩溃更糟：失败必须大声报 + 留原文，人能补救
			console.log(`⚠ 抽取结果不是合法 JSON，本会话记忆未写入！原文前 200 字：${(message?.content || '').slice(0, 200)}`)
			return
		}
		if (!Array.isArray(toMemories) || !toMemories.length) {
			console.log('没有要写入的记忆')
			return
		}
		// 这样写有个坑，如果同时有多个记忆，Promise.all 并发写同名文件会互相覆盖，导致少记
		for (let item of toMemories) {
			await writeMemoryTool.impl(item)
		}
		console.log('批量写入记忆完成')
	} catch (err: any) {
		console.log('记忆抽取钩子出错（不影响本次回答）:', err?.message)
	}
}

// ---------- 主流程 ----------
// 只在直接作为脚本入口运行时执行（node 07-memory/mini_agent.ts N）；
// 被回归测试 import 时不自动跑——主模块判断保护脚本入口
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
	const SESSION = process.argv[2] ?? '1'
	if (SESSION === '1') {
		// 测试写入记忆
		const ctx = await createAgent('北京今天会下雨吗？如果会下雨，我给全家 5 口人每人买一把 25 元的伞，帮我算算一共多少钱。查一下我笔记里关于买伞的记录，再结合北京天气决定买不买')
		const answer = await agentLoop(ctx)
		console.log('\n=== 最终回答 ===\n' + answer)
	} else if (SESSION === '2') {
		// 测试读取记忆
		const ctx = await createAgent('我家有几口人')
		const answer = await agentLoop(ctx)
		console.log('\n=== 记忆读取 ===\n' + answer)
	} else if (SESSION === '3') {
		// 测试写入记忆
		const ctx = await createAgent('我们家，我是赵德升，媳妇是李露露，儿子是赵睿泽，弟弟是赵德财，妹妹是赵慧，爸爸是赵立成，妈妈是孙花，一共几个人？')
		const answer = await agentLoop(ctx)
		console.log('\n=== 家庭成员人名告知，验证是否会存记忆 ===\n' + answer)
	} else if (SESSION === '4') {
		// 测试记忆读写
		const ctx = await createAgent('我1994年出生的，我老婆比我小一岁，请输出我媳妇的名字和年龄')
		const answer = await agentLoop(ctx)
		console.log('\n=== 年龄告知与年龄计算，验证是否会存记忆，并且读取之前的媳妇名字的记忆 ===\n' + answer)
	} else if (SESSION === '5') {
		//
		const ctx = await createAgent('我喜欢熬夜，我媳妇说熬夜不好，容易长痘痘，她不喜欢熬夜。熬夜到底好不好。')
		const answer = await agentLoop(ctx)
		console.log('\n=== 测试偏好是否存入记忆 ===\n' + answer)
	} else if (SESSION === '6') {
		//
		const ctx = await createAgent('我和我媳妇，平常谁睡的更早')
		const answer = await agentLoop(ctx)
		console.log('\n=== 测试偏好 ===\n' + answer)
	} else if (SESSION === '7') {
		//
		const ctx = await createAgent('我小时候经常跟发小一起去我们那的小河里洗澡，但是我还是没学会游泳，其他的发小都学会了。也去小河里摸过鱼，也没有其他发小摸到的多。我是不是手慢，动手能力差？')
		const answer = await agentLoop(ctx)
		console.log('\n=== 测试用户信息披露时是否记忆 ===\n' + answer)
	} else if (SESSION === '8') {
		//
		const ctx = await createAgent('你猜我会游泳不？')
		const answer = await agentLoop(ctx)
		console.log('\n=== 游泳 ===\n' + answer)
	} else if (SESSION === '9') {
		//
		const ctx = await createAgent('我2024-10-10去民政局领证的，2021-10-14办的婚礼，结婚算不算晚')
		const answer = await agentLoop(ctx)
		console.log('\n=== 结婚年龄 ===\n' + answer)
	} else if (SESSION === '10') {
		//
		const ctx = await createAgent('我结婚多久了')
		const answer = await agentLoop(ctx)
		console.log('\n=== 结婚时长 ===\n' + answer)
	} else if (SESSION === '11') {
		//
		const ctx = await createAgent('我实际是2024-10-14办的婚礼，农历9月12')
		const answer = await agentLoop(ctx)
		console.log('\n=== 结婚信息变更 ===\n' + answer)
	} else if (SESSION === '12') {
		//
		const ctx = await createAgent(
			'我学前班在村里的分校上的，离家近。回家的途中经过爷爷家，所以中午经常到爷爷家吃饭。一年级也是这个学校，二年级没上完，就转到村里的总校了，距离可远了，家在山顶，每次需要先下山，然后过河，在上山到学校。放学又是这样，先下山，再过河，然后上山。4年级上完，村里的五六年级撤了，我就转学到隔壁村去上了，隔壁村叫柳泉村，我们村叫罗台村，我家是二组。柳泉小学上完5年级后，这个学校的五六年级也撤了，我又转学到镇上的中心小学——金家小学上6年级。在柳泉上学的时候，先下山，再过河，然后平路1-2公里到学校。金家小学远，我就开启了住校生活，以后上学全是住校。我的小学经历是不是有点丰富',
		)
		const answer = await agentLoop(ctx)
		console.log('\n=== 小学经历 ===\n' + answer)
	} else if (SESSION === '13') {
		//
		const ctx = await createAgent('我决定放弃前端职业生涯，转行做Agent开发了，这个决定怎么样')
		const answer = await agentLoop(ctx)
		console.log('\n=== 职业生涯 ===\n' + answer)
	} else if (SESSION === '14') {
		//
		const QUESTIONS = [
			'我家有几口人',
			'我的童年经历有啥',
			'我媳妇叫啥',
			// '我的职业生涯情况'
		]

		for (let q of QUESTIONS) {
			const ctx = await createAgent(q)
			const answer = await agentLoop(ctx)
			console.log(`\n=== ${q} ===\n` + answer)
		}
	} else if (SESSION === 'all') {
		// 回归跑批：只跑幂等的读测试（问答不产生新事实）。
		// 写测试（1,3,4,5,7,9,11,12,13）别盲跑——老案例里的事实已过期（如会话 1 的"5 口人"），
		// 而合并规则是"冲突以新为准"，重跑等于拿旧事实覆盖新事实，会把 family-size 搅坏
		const READ_ONLY_QUESTIONS = ['我家有几口人', '我和我媳妇，平常谁睡的更早', '你猜我会游泳不？', '我结婚多久了', '我的童年经历有啥', '我媳妇叫啥']
		for (const q of READ_ONLY_QUESTIONS) {
			const ctx = await createAgent(q)
			const answer = await agentLoop(ctx)
			console.log(`\n=== ${q} ===\n` + answer)
		}
	} else if (SESSION === 'new_memory') {
		// 新信息，应该增加记忆
		const READ_ONLY_QUESTIONS = ['我红绿色弱', '我皮肤不好，容易得皮肤病，后脑勺经常发作毛脑炎', '我屁股长过2次疖肿', '我窦性心律，心电轴显著右偏',]
		for (const q of READ_ONLY_QUESTIONS) {
			const ctx = await createAgent(q)
			const answer = await agentLoop(ctx)
			console.log(`\n=== ${q} ===\n` + answer)
		}
	} else if (SESSION === 'test2') {
		// 新信息，应该增加记忆
		const READ_ONLY_QUESTIONS = ['我媳妇叫啥', '我今年32岁了', '我儿子今年3.1号出生的，还不会爬', '最近几个月两个胳膊长了3次湿疹了，最近用999皮炎平快治好了，泡泡基本消了']
		for (const q of READ_ONLY_QUESTIONS) {
			const ctx = await createAgent(q)
			const answer = await agentLoop(ctx)
			console.log(`\n=== ${q} ===\n` + answer)
		}
	} else {
		// 把用户执行脚本时的第二个参数当输入
		// 我家里的人，除了我弟弟，都不喜欢吃辣的，媳妇不喜欢吃甜的，怕长胖
		// 中午有推荐的吃的没
		// 我大学2017那年毕业，现在毕业多少年了
		// 我2013年在十堰市郧阳区第一中学毕业，然后进入的延安大学，大学当时是二本，现在是一本了。高中暑假去打暑假工，干的洗车的活，一天40块钱，全月无休，还把脚泡伤了，挣的钱还被一个亲戚骗了。我太难了
		const ctx = await createAgent(SESSION)
		const answer = await agentLoop(ctx)
		console.log(`\n=== 用户输入的问题：${SESSION} ===\n` + answer)
	}
}
