// 模块 09：Agent Harness —— 在 08 的 planner-executor 上加工程壳（累积式，不丢旧能力）
//
// 本文件仍是裸 ReAct 循环，身兼三职：
//   ① 验收实验的对照组（08 §6 的裸 ReAct 臂，暂缓中）
//   ② planner.ts 里每个步骤的「步骤执行器」（executePlan 每步调一次 createAgent + agentLoop）
//   ③ harness 的接线现场：dispatch 是所有工具调用的**唯一咽喉**——
//      §1 权限闸（./permissions.ts）接在这里；§3 的 pre/post-hook、§2 沙箱也都在这一层进。
//      单点接入是纪律：权限检查散落在各工具 impl 里 = 一定有漏网的（§0 的「没有它会出什么事」）
// 调度层（出图/打勾/replan/并发）全部在 ./planner.ts，不碰这里的循环本体。
//
// 工具定义在 ./tools.ts（内置）和 ./memory.ts（记忆工具，启动时注册进来）；
// 上下文的四件武器（测量/截断/压缩/窗口）全部在 ./context.ts 的 ContextManager 里：
//   双账本：ledger 完整历史（存储），view 发送视图（压缩/开窗只动它）。
//   循环里的约定：每步先 ctx.ensureBudget()，再 ctx.getSendView() 发给 API；
//   新消息一律 ctx.add()（双写）——不直接 push 任何数组。
import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ContextManager, truncateToolResult } from './context.ts'
import { checkPermission, type Verdict } from './permissions.ts'
import { MemoryManager, registerMergeStrategy, writeMemoryTool } from './memory.ts'
import { registerSandboxTools } from './sandbox.ts'
import { collectEnv, renderEnvBlock, refreshEnvBlock } from './env.ts'
import { newSessionId, saveSession, loadSession, listSessions, archiveSession, renameSession } from './persist.ts'
import { runPreHooks, runPostHooks, runSessionEndHooks, registerSessionEndHook } from './hooks.ts'
import type { PreHookResult } from './hooks.ts'
import { registry, buildToolsParam } from './tools.ts'
import type { ToolCallParams } from './type.ts'

// 平台配置全部走 llm.ts（从 .env 读 LLM_BASE_URL/LLM_MODEL/LLM_API_KEY/LLM_BUDGET_TOKENS）——
// 换平台只改 .env 不改代码。client/MODEL/BUDGET_TOKENS 的唯一事实源在 llm.ts，这里 re-export，
// 下游（planner.ts、10-multi-agent）照旧 `import { client, MODEL } from './agent.ts'` 不用改。
import { client, MODEL, BUDGET_TOKENS, THINKING_STYLE, lightClient, LIGHT_MODEL, backupClient, BACKUP_MODEL } from './llm.ts'
export { client, MODEL, BUDGET_TOKENS, lightClient, LIGHT_MODEL, backupClient, BACKUP_MODEL }

// ---------- 工具注册 ----------
// 内置工具在 ./tools.ts 里定义并注册（import 时完成）；记忆工具来自 ./memory.ts，
// 启动时注册一次——注册是启动动作，不放在 buildToolsParam 里每次循环重复做
// ---------- 写入策略开关（A/B 对比实验） ----------
// A = 模型自主（write_memory 满血 description + 提示词写入引导）
// B = 会话结束钩子抽取（不注册 write_memory，模型看不到它——条件才干净）
// AB = 两个都开（默认）
// 用法：WRITE_STRATEGY=B node 09-harness/agent.ts 2
const WRITE_STRATEGY = (process.env.WRITE_STRATEGY ?? 'AB').toUpperCase() as 'A' | 'B' | 'AB'

console.info('本次策略是：' + WRITE_STRATEGY)
MemoryManager.registerMemoryTools(registry, WRITE_STRATEGY)
// §2 沙箱工具：run_shell（cwd 锁死 + 超时 + 三层拦截；权限层它在 confirm 列表——人批+沙箱筛双闸）
registerSandboxTools()
// §3 hooks：内置 post-hook（脱敏+审计）随 hooks.ts 的 import 已注册；
// B 策略记忆抽取迁入正式的会话结束钩子——agentLoop 的两个出口不再各自内联
if (WRITE_STRATEGY !== 'A') {
	registerSessionEndHook(extractMemories)
}

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
async function dispatch(toolCall: ToolCallParams): Promise<string> {
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
	// §3 pre-hook：在权限闸【前】——改写先发生，权限判定的是改写后的最终参数
	// （hook 把 echo 改成 del，权限看到 del 并拒绝；放权限后 = 改写逃过审判）。
	// pre 经过一切调用（含被拒的）；post 只见真执行了的。管线出错按拦截处理，不崩循环
	let pre: PreHookResult
	try {
		pre = await runPreHooks(toolName, args)
	} catch (err: any) {
		return JSON.stringify({ error: `pre-hook 管线失败（按拦截处理）:${err?.message}` })
	}
	if (pre.blocked) {
		return JSON.stringify({ error: `pre-hook 拦截：${pre.blocked}` })
	}
	if (pre.args !== undefined) {
		args = pre.args // 改写后的参数才进权限判定和 impl
	}
	// 权限闸（§1）：唯一咽喉的唯一闸门——args 解析完、impl 执行前。
	// 权限系统自身出错也不能把循环崩了：闸门坏了按「拦下」处理（fail-closed），
	// 错误信息喂给模型；拒绝也按「永不抛」约定返回 JSON——模型看得懂，还能换路子
	let verdict: Verdict
	try {
		verdict = await checkPermission(toolName, args)
	} catch (err: any) {
		return JSON.stringify({ error: `权限判定失败（按拒绝处理）:${err?.message}` })
	}
	if (verdict === 'deny') {
		return JSON.stringify({ error: `权限拒绝：${toolName} 不在允许范围，本次调用被 harness 拦截` })
	}
	try {
		const res = await def.impl(args)
		let raw = JSON.stringify(res)
		// 源头减量：结果进 messages 之前就砍，别等超预算再救
		// （它本质是个内置 post-hook，先跑——后面的审计/脱敏 hook 拿到的是终态）
		if (def.maxResultTokens) {
			raw = truncateToolResult(raw, def.maxResultTokens)
		}
		// §3 post-hook 最后跑：脱敏 → 审计（注册顺序即安全问题，见 hooks.ts）
		return await runPostHooks(toolName, args, raw)
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
export type ToolCallObserver = (info: { name: string; arguments: string; result: string }) => void

// 思考级别（人类可读意图）——具体怎么翻译成平台载荷由 buildThinkingParam 管（协议是平台相关的，
// 读 .env 的 LLM_THINKING_STYLE 决定，换模型只改配置不改代码）：
//   undefined → 不带参数（端点默认）
//   'low' | 'high' | 'max' → 开启思考 + 给强度；'off' → 关闭思考
// 低思考的浅任务（判形状/critic 对审）用 off，别让 completion 大头烧在思考 token 上
export type ModelThinkingLevel = 'low' | 'high' | 'max' | 'off'

// 把思考意图翻译成 OpenAI-compatible 载荷——协议随 LLM_THINKING_STYLE 走（火山/GLM/DeepSeek 用
// {type:enabled/disabled}+reasoning_effort；bool 模型用单个 true/false；none 不传）。
// 教训：曾裸传字符串 'high' 撞出火山 "Mismatch type openapi.Thinking"——翻译层必须知道模型协议，
// 而协议是配置不是代码。reasoning_effort 只在该发时发（high 常是默认，低/高差异才值得带参数）
export function buildThinkingParam(level?: ModelThinkingLevel): object {
	const style = THINKING_STYLE
	if (style === 'none') return {}
	if (style === 'bool') {
		if (!level) return {}
		return { thinking: level !== 'off' }
	}
	// openapi（火山/GLM/DeepSeek）风格
	if (!level || level === 'off') return level === 'off' ? { thinking: { type: 'disabled' } } : {}
	const strength = level === 'low' || level === 'max' ? { reasoning_effort: level } : {}
	return { thinking: { type: 'enabled' }, ...strength }
}

// 配置项打包（§5 重构）：可选位置参数堆到两个 + 调用点出现 undefined 洞（(ctx, 8, undefined, sid)）
// 就是换形状的信号——主题参数（ctx，必选）保持位置参数，配置进对象：调用点自解释，
// 以后加配置项不再动既有调用点。onToolCall 没并入 §3 post-hook：覆盖面不同——
// post-hook 只见真执行了的调用（被 pre/权限拒的在它之前就 return 了），观察者连拒绝也上报
export interface AgentLoopOptions {
	maxSteps?: number // 默认 8——历史步数预算，resume 后重起算
	onToolCall?: ToolCallObserver // 回归测试观察者：捕获工具调用序列（含被拒的，result 是错误 JSON）
	onUsage?: (u: { promptTokens: number; completionTokens: number }) => void // 模块 10 spawn 的账本探针：每次请求上报 token 用量——多 agent 成本核算（×N 记账）的数据入口
	tools?: string[] // 工具面白名单：undefined=全量（默认，既有调用零改动）；[]=纯文本 agent；数组=只挂列名的（§5 教训的工具化：工具面=能力面）
	thinking?: ModelThinkingLevel // 思考开关：false → 请求体带 thinking:{type:'disabled'}（GLM 端点参数）；undefined/true → 不带（端点默认=开）。浅任务（判形状/转写/对单评审）关掉——completion 大头是思考 token，墙钟≈completion÷输出速度
	skipSessionEndHooks?: boolean // 短命子 agent 的选择权：结论已回传，过程记忆大概率无价值；钩子虽 fire-and-forget 不挡循环，但会拖住进程退出（Node 等事件清空）
	sessionId?: string // §5 存档 id——传了才落盘，每步一存档
	useLightModel?: boolean // 模块 11 §7 大小模型路由：true=浅窗口走便宜小档（llm.ts 的 LLM_LIGHT_*；未配小档自动回落主模型——配置缺省不是错误）
	useBackupModel?: boolean // §7 配额 failover：主档撞 quota 429 后由 spawnReliable 置 true 重发（备用档优先于小档路由——逃生覆盖省钱）
}

export async function agentLoop(ctx: ContextManager, { maxSteps = 8, onToolCall, onUsage, sessionId, tools: toolNames, thinking, skipSessionEndHooks, useLightModel }: AgentLoopOptions = {}): Promise<string> {
	let step = 1
	const tools = buildToolsParam(toolNames)
	// §5 检查点：每步工具结果落盘后，进程中途被杀也能从最近一步 resume（08 plan-checkpoint 的教训：
	// 检查点要存「进行到哪」而不是只存「跑完的」）。saveSession 自带永不抛纪律，这里放心 await
	const checkpoint = async () => {
		if (sessionId) await saveSession(sessionId, ctx.ledger)
	}

	while (true) {
		if (step > maxSteps) {
			await checkpoint()
			// §3 会话结束钩子（B 策略抽取已迁入 hooks.ts 的挂载点，这里不再内联）
			if (!skipSessionEndHooks) void runSessionEndHooks(ctx)
			return JSON.stringify({ error: '(达到最大步数，任务中止)' })
		}
		await ctx.ensureBudget()
		ctx.logBreakdown()
		// §7 路由：浅窗口换小档（client+model 成对换——小档可能在按量端点上，不能只换名不换端点）；未配小档双双回落主模型
		// §7 failover：useBackupModel 优先于 useLightModel——配额逃生盖过省钱路由（同一窗口最多活一个档位决策）
		const chat = useBackupModel && backupClient ? backupClient : useLightModel && lightClient ? lightClient : client
		const chatModel = useBackupModel && BACKUP_MODEL ? BACKUP_MODEL : useLightModel && LIGHT_MODEL ? LIGHT_MODEL : MODEL
		const response = await chat.chat.completions.create({
			model: chatModel,
			messages: ctx.getSendView(),
			// 空工具面省略 tools 字段——空数组在部分 API 是「禁用工具」在部分是错误，省略是唯一安全形态
			...(tools.length ? { tools } : {}),
			// 思考参数：由 buildThinkingParam 把人类可读级别翻译成平台载荷（thinking.type: enabled/disabled
			// 是火山/GLM 协议）——别直接透传字符串（撞过 400 Mismatch type openapi.Thinking）
			...buildThinkingParam(thinking),
		})
		console.log('真实token用量：', response.usage?.prompt_tokens)
		onUsage?.({ promptTokens: response.usage?.prompt_tokens ?? 0, completionTokens: response.usage?.completion_tokens ?? 0 })
		const message = response.choices[0].message
		const toolCalls = (message.tool_calls ?? []) as any[]
		ctx.add(message)
		if (!toolCalls.length) {
			await checkpoint()
			// §3 会话结束钩子（两个出口——正常答完/步数中止——现在共用一个挂载点）
			if (!skipSessionEndHooks) void runSessionEndHooks(ctx)
			return message.content || JSON.stringify({ error: '模型未返回内容' })
		}
		console.log(`[step ${step}] 调用: ${toolCalls.map((t) => `${t.function.name}(${t.function.arguments})`).join(', ')}`)
		const toolRes = await Promise.all(toolCalls.map(async (tool) => await dispatch(tool)))
		toolRes.forEach((item, index) => {
			console.log(`[step ${step}] 工具结果: ${toolCalls[index].function.name} -> ${item}`)
			ctx.add({ role: 'tool', tool_call_id: toolCalls[index].id, content: item })
		})
		await checkpoint() // 每步存档：崩溃损失 = 最多一步
		onToolCall && toolCalls.forEach((tc, index) => onToolCall({ name: tc.function.name, arguments: tc.function.arguments, result: toolRes[index] }))
		step++
	}
}

// 启动一个新任务（budgetTokens 可覆盖——回归测试的低预算场景用；默认模块级 BUDGET_TOKENS；
// systemExtra：追加到 system 末尾的常驻内容——planner 模式用它注入「带勾的最新计划」）
export async function createAgent(task: string, opts?: { budgetTokens?: number; systemExtra?: string; tools?: string[] }): Promise<ContextManager> {
	const ctx = new ContextManager(client, MODEL, { budgetTokens: opts?.budgetTokens ?? BUDGET_TOKENS, toolsDef: buildToolsParam(opts?.tools) })
	const memoryPrompt = await MemoryManager.getSystemPrompt(WRITE_STRATEGY !== 'B')
	// 清洗历史数据，执行过一次就好了
	// await historyMemoryToVector()
	// §4 环境注入：会话开始采一次快照拼进 system（机制同 07 索引常驻/08 计划常驻——同一模式第三次复用）。
	// 注意账：planner 模式每步一个子 agent，每步都重新采集+付这份 token（百级）——见 env.ts 头注的时机推导
	const env = await collectEnv()
	// 常驻注入的定界符规矩（§5 定稿）：每类注入一段、成对标签锁区间——<memories>（这里）、
	// <env>（env.ts）、<plan>（planner.ts 自己带）。替换类操作（resume 的环境刷新）按标签定位，
	// 不从拼接结果里猜结构——拼接的人拥有定界符（谁写谁负责让边界可被机器找到）
	ctx.add({ role: 'system', content: SYSTEM_PROMPT + `\n<memories>\n${memoryPrompt}\n</memories>` + `\n${renderEnvBlock(env)}` + (opts?.systemExtra ? `\n${opts.systemExtra}` : '') })
	ctx.add({ role: 'user', content: task })
	return ctx
}

// 模型输出的 JSON 永远不可信：哪怕提示词写了"纯 JSON"，它还是可能包一层 ```json 围栏。
// 先剥围栏再 parse；剥完还不合法返回 undefined，由调用方大声报错走兜底
export function parseModelJson(raw: string | null | undefined): any {
	if (!raw) return undefined
	let text = raw.trim()
	if (text.startsWith('```')) {
		text = text
			.replace(/^```(?:json)?\s*/i, '')
			.replace(/```\s*$/, '')
			.trim()
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
			'name 是记忆的存储键（文件名），必须匹配 ^[a-z0-9-]+$（小写字母数字连字符，如 laptop-spec、os-version），禁止中文——write_memory 会按此校验，中文直接拒；' +
			'只记录对话中出现的事实，不要补充建议、推断或常识；时间一律写成绝对日期（如2026年3月1日），不要用"今年""最近几个月"这类相对表述；今天是 ' +
			new Date().toISOString().slice(0, 10) +
			'（以此换算相对表述，别用训练数据里的旧年份）；abstract 不超过30字。会话：' +
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

		// 接线决策（2026-10-17）：钩子写记忆一视同仁走 dispatch——权限检查在 dispatch 里做，
		// 这里不再手动 checkPermission（查两遍 = TTY 下每条记忆弹两次 y/n，违背单点咽喉纪律）。
		// 代价：无头模式（planner/cron）write_memory 是 confirm → 默认拒 → 记忆不写入（下方大声报）。
		// 参数是单个对象不是数组——impl 签名是 WriteMemoryItem
		let okCount = 0
		let failCount = 0
		for (const item of toMemories) {
			const res = await dispatch({
				function: {
					name: writeMemoryTool.name,
					arguments: JSON.stringify(item),
				},
			})
			// 机读成败：dispatch 返回的是 JSON.stringify(impl 的字符串返回)，{error} 被套了两层——
			// 拆到不是字符串为止。纯文本（成功消息/校验错误）拆一层就到头，对象带 .error 即失败
			let result: any = parseModelJson(res)
			while (typeof result === 'string') result = parseModelJson(result)
			if (result?.error) {
				// 钩子的返回值没人接——失败必须在这里大声报 + 留条目原文，人能补救（07 的老规矩）
				console.log(`⚠ 记忆写入失败未落盘：${result.error} | 条目: ${JSON.stringify(item).slice(0, 120)}`)
				failCount++
			} else {
				okCount++
			}
		}
		// 汇报真实结果——"完成"两个字撒过谎（0 条写入也打完成），计数不撒谎
		console.log(`批量写入记忆结束：${okCount} 成功 / ${failCount} 失败${failCount ? '（失败条目见上方 ⚠）' : ''}`)
	} catch (err: any) {
		console.log('记忆抽取钩子出错（不影响本次回答）:', err?.message)
	}
}

// ---------- 主流程 ----------
// 只在直接作为脚本入口运行时执行（node 09-harness/agent.ts N 或自由文本）；
// 被回归测试 import 时不自动跑——主模块判断保护脚本入口。
// 测试语料含真实个人信息，不入库：全部放 .sessions.json（已 gitignore）——
// 键 = 会话号/名字，值 = 字符串（单会话）或数组（跑批）；未命中的输入直接当自由文本。
// 注意：写类会话（3,4,5,7,9,11,12,13,new_memory,test2）别盲跑——老案例里的事实已过期
// （如会话 1 的"5 口人"），而合并规则是"冲突以新为准"，重跑等于拿旧事实覆盖新事实
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
	const SESSION = process.argv[2] ?? '1'
	// §5 resume 分支：node 09-harness/agent.ts resume <会话id> "继续指令"——
	// 恢复 = 读档 → 新 ContextManager 逐条重放 add()（双写，view 自动重建）→
	// 刷新环境块（时钟/文件树是旧会话采的）→ 追加新 user 消息继续跑。
	// 不能走 createAgent：它新开 system+user，恢复出来的不是同一个会话
	if (SESSION === 'resume') {
		const [id, task] = [process.argv[3], process.argv[4]]
		if (!id || !task) {
			console.error('用法：npm run m9 -- resume <会话id> "继续指令"（会话 id 见每次跑完打印的存档号）')
			process.exit(1)
		}
		const ledger = await loadSession(id)
		if (!ledger?.length) {
			console.error(`会话 ${id} 恢复不了（sessions/ 下没有对应文件，或内容是空的）`)
			process.exit(1)
		}
		// 工具面有意全量：09 主 demo 是 harness 展示位（天气/算数/笔记/记忆/shell 全套），不传白名单 = 全量是这里的选择而非默认
		const ctx = new ContextManager(client, MODEL, { budgetTokens: BUDGET_TOKENS, toolsDef: buildToolsParam() })
		for (const msg of ledger) ctx.add(msg)
		await refreshEnvBlock(ctx) // 边界②：环境块重采——别拿上次的时钟推理
		ctx.add({ role: 'user', content: task })
		const answer = await agentLoop(ctx, { sessionId: id }) // 沿用原 id 续档：resume 之后还能再 resume
		console.log(`\n=== 续答（会话 ${id}）===\n` + answer)
	} else if (SESSION === 'list') {
		// 历史会话列表：元数据全部从存档派生（尾巴定状态、首条 user 定标题），没有中央索引
		const metas = await listSessions()
		if (!metas.length) {
			console.log('还没有任何会话存档（跑完任意会话后自动生成）')
		} else {
			console.log('历史会话（新的在前）：')
			for (const m of metas) console.log(`  ${m.id}  [${m.status}] ${m.msgCount} 条 | ${m.title}`)
			console.log('\n续跑：npm run m9 -- resume <id> "指令"；归档：npm run m9 -- archive <id>；改名：npm run m9 -- rename <id> "标题"')
		}
	} else if (SESSION === 'archive') {
		const id = process.argv[3]
		if (!id) {
			console.error('用法：npm run m9 -- archive <会话id>（id 用 list 查）')
			process.exit(1)
		}
		console.log((await archiveSession(id)) ? `已归档 ${id}（挪入 sessions/archive/，挪回即恢复）` : '归档失败，见上方报错')
	} else if (SESSION === 'rename') {
		const [id, title] = [process.argv[3], process.argv[4]]
		if (!id || !title) {
			console.error('用法：npm run m9 -- rename <会话id> "新标题"（id 用 list 查）')
			process.exit(1)
		}
		console.log((await renameSession(id, title)) ? `已改名：${title}` : `会话 ${id} 不存在或读不了，改名失败`)
	} else {
		let sessions: Record<string, string | string[]> = {}
		try {
			sessions = JSON.parse(await fs.readFile(path.resolve(import.meta.dirname, '.sessions.json'), 'utf8'))
		} catch {
			console.error('没找到/读不了 09-harness/.sessions.json（个人测试语料，不入库）——缺了就照旧格式新建一份')
			process.exit(1)
		}
		const entry = sessions[SESSION]
		// 字符串 → 单会话；数组 → 跑批；都没命中 → argv 原文当自由文本（node 09-harness/agent.js "今天天气如何"）
		const questions = typeof entry === 'string' ? [entry] : Array.isArray(entry) ? entry : [SESSION]
		for (const q of questions) {
			const ctx = await createAgent(q)
			const sid = newSessionId()
			const answer = await agentLoop(ctx, { sessionId: sid })
			console.log(`\n=== ${q.slice(0, 24)} ===\n` + answer + `\n[会话已存档 ${sid}——续跑：npm run m9 -- resume ${sid} "下一步指令"]`)
		}
	}
}

// npm run m9 -- list                          # 老档（裸数组格式）也能列出 = 迁移生效
// npm run m9 -- rename <id> "测试标题"
// npm run m9 -- list                          # 显示「测试标题」而不是首条截断 = L3 生效
// npm run m9 -- resume <id> "随便问点什么"     # 跑完再 list——标题还是「测试标题」
//                                             # = checkpoint 没把改名冲掉（标题保全生效，最关键一发）
