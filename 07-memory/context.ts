// 模块 06：ContextManager —— 上下文管理的统一管理器（四件武器集齐）
//
// 核心设计：双账本（解决「压缩把调用方的历史弄丢」的引用 bug）
//   ledger 完整历史，只增不删——存储（底账）；
//   view   发送视图，超预算时被压缩/开窗——视图。
//   压缩只重建 view（manager 内部所有，外部拿不到引用，重赋值天然安全），
//   ledger 永不动；新消息双写。这就是「窗口/压缩是 view 不是 storage」的类实现。
//
// 优化层级（先便宜的，贵的自然少触发）：
//   ① 源头减量：工具结果截断 truncateToolResult（dispatch 里用，进 messages 之前砍）
//   ② 有损压缩：compaction（旧轮摘要成一条，近期轮原文保留；轮 = user 消息到下一条 user 之前）
//   ③ 存量兜底：滑动窗口（按整轮丢最旧的；压缩后仍超预算才轮到它）
//
// 预算口径：total = system + 历史 + 工具定义 + 工具结果（tools 定义也计费，必须算进预算）。
// estimateTokens 是校准过的粗估（中文≈1 token/字，英文≈4 字符/token），用途是决策阈值，不是计费。

// ---------- 估算 ----------
export function estimateTokens(text: string): number {
	return (text || '').replace(/[^\x00-\xff]/g, 'xxxx').length / 4
}

// message.content + message.tool_calls的name+arguments 的 token 估算
function getMessagesTokens(messages: any[]): number {
	return messages.reduce((sum, m) => {
		const toolCallsTokens = m.tool_calls ? m.tool_calls.reduce((toolSum, t: any) => toolSum + estimateTokens(`${t.function.name}(${t.function.arguments})`), 0) : 0
		return sum + estimateTokens(m.content) + toolCallsTokens
	}, 0)
}

// ---------- 武器①：工具结果截断（源头减量） ----------
// 头尾各留 max 的 1/3（中间 1/3 的余量给截断标记），head+tail ≤ max。
// 已知局限：字符级截断会把 JSON 结构砍碎；真实系统会先 parse 保留前 N 条再序列化（语义级截断）。
export function truncateToolResult(result: string, maxTokens: number = 300): string {
	const originTokens = estimateTokens(result)
	if (originTokens <= maxTokens) {
		return result
	}
	const headCount = Math.floor(maxTokens / 3)
	const tailCount = Math.floor(maxTokens / 3)
	return result.substring(0, headCount) + `....[已截断，原始 ${Math.round(originTokens)} tokens]...` + result.substring(result.length - tailCount)
}

// ---------- 轮次分组 ----------
// 一轮 = 一条 user 消息 + 它引发的所有 assistant/tool_calls/tool 消息 + 最终回答。
// 窗口和压缩的边界都必须落在轮与轮之间：配对完整（tool 不孤儿）+ 语义完整（有问必有答）。
export type Turn = { messages: any[] }

export function groupTurns(messages: any[]): Turn[] {
	const turns: Turn[] = []
	for (const message of messages) {
		if (message.role === 'user') {
			turns.push({ messages: [message] })
		} else {
			// system 后、第一条 user 前的消息（理论上不会有）静默挂到最后一个轮
			turns[turns.length - 1]?.messages.push(message)
		}
	}
	return turns
}

// ---------- 四桶测量 ----------
export function getContextTokens(messages: any[], tools: any[]): { systemTokens: number; historyTokens: number; toolsDefTokens: number; toolsResTokens: number; totalTokens: number } {
	const system = messages.find((m) => m.role === 'system')?.content || ''
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
	return { systemTokens, historyTokens, toolsDefTokens, toolsResTokens, totalTokens: systemTokens + historyTokens + toolsDefTokens + toolsResTokens }
}

// ---------- ContextManager ----------
export type ContextManagerStats = {
	compactions: number // 压缩次数
	compactionCostTokens: number // 压缩调用自身的累计成本（输入+输出都要花钱）
	savedTokensPerTurn: number // 压缩后每次发送省下的估算量（≈ 压缩前 view - 压缩后 view）
}

export class ContextManager {
	readonly ledger: any[] = [] // 底账：完整历史，只增不删
	private view: any[] = [] // 视图：真正发给 API 的（压缩/开窗只动它）
	readonly stats: ContextManagerStats = { compactions: 0, compactionCostTokens: 0, savedTokensPerTurn: 0 }

	// 注意：Node 24 原生跑 .ts 是 strip-only 模式，不支持 constructor 参数属性简写
	// （private client: any 这种），必须显式声明字段 + 构造函数里手动赋值
	private client: any
	private model: string
	private opts: { budgetTokens: number; toolsDef: any[]; summarizePrompt?: string }

	constructor(client: any, model: string, opts: { budgetTokens: number; toolsDef: any[]; summarizePrompt?: string }) {
		this.client = client
		this.model = model
		this.opts = opts
	}

	// 新消息双写：底账记全量，视图跟着长
	add(message: any) {
		this.ledger.push(message)
		this.view.push(message)
	}

	// 每次请求前调用：不超预算直接过；超了先压缩（有损、花一次 LLM 调用），还超再开窗兜底
	async ensureBudget(): Promise<void> {
		const before = getContextTokens(this.view, this.opts.toolsDef).totalTokens
		if (before <= this.opts.budgetTokens) return

		const beforeView = this.view
		const { systemMessage, retainedMessages, messagesToSummarize } = this.analyzeMessages(this.view)
		if (messagesToSummarize.length) {
			const { summaryMessage, costTokens } = await this.summarizeMessages(messagesToSummarize)
			// view 是 manager 私有的，重赋值不会断任何外部引用——当初的 bug 在这个设计下结构性消失
			this.view = [systemMessage, summaryMessage, ...retainedMessages].filter(Boolean)
			this.stats.compactions++
			this.stats.compactionCostTokens += costTokens
			this.stats.savedTokensPerTurn = before - getContextTokens(this.view, this.opts.toolsDef).totalTokens
			const breakEven = this.stats.savedTokensPerTurn > 0 ? Math.ceil(costTokens / this.stats.savedTokensPerTurn) : Infinity
			console.log(`\n[compaction] 第 ${this.stats.compactions} 次：视图 ${beforeView.length} 条 → ${this.view.length} 条`)
			console.log(`[compaction] 本次成本 ${costTokens} tokens（输入+输出），之后每轮约省 ${this.stats.savedTokensPerTurn}，break-even ≈ ${breakEven} 轮，累计成本 ${this.stats.compactionCostTokens} tokens`)
			console.log(`[compaction] 底账不变：${this.ledger.length} 条完整保留`)
		}

		// 兜底：压缩后（或没得压缩时）仍超预算 → 开窗丢最旧的整轮
		this.view = this.applyWindow(this.view)
	}

	// 发送视图（ensureBudget 之后调用）
	getSendView(): any[] {
		return this.view
	}

	// 武器②的前半：决定哪些轮摘要、哪些轮原文保留
	// verbatim 区 = 预算一半；最新一轮永远原文保留（超了就超了，warn），否则正在进行的任务被摘要掉
	private analyzeMessages(messages: any[]): { systemMessage: any; retainedMessages: any[]; messagesToSummarize: any[] } {
		const turns = groupTurns(messages)
		const systemMessage = messages.find((m) => m.role === 'system')
		const retainedMessages: any[] = []
		const messagesToSummarize: any[] = []
		const halfBudgetTokens = this.opts.budgetTokens / 2
		let currentTokens = 0

		for (let i = turns.length - 1; i >= 0; i--) {
			const turnMessages = turns[i].messages
			const turnTokens = getMessagesTokens(turnMessages)
			if (currentTokens + turnTokens <= halfBudgetTokens) {
				retainedMessages.unshift(...turnMessages)
				currentTokens += turnTokens
			} else if (!retainedMessages.length) {
				console.warn(`[compaction] 最新一轮 ${Math.round(turnTokens)} tokens 超过 verbatim 半预算 ${halfBudgetTokens}，仍然原文保留`)
				retainedMessages.unshift(...turnMessages)
				currentTokens += turnTokens
			} else {
				messagesToSummarize.unshift(...turnMessages)
			}
		}
		return { systemMessage, retainedMessages, messagesToSummarize }
	}

	// 武器②：旧轮 → LLM 摘要。摘要质量 = 这个 prompt 的质量，这是 compaction 真正的功课
	private async summarizeMessages(messagesToSummarize: any[]): Promise<{ summaryMessage: any; costTokens: number }> {
		const response = await this.client.chat.completions.create({
			model: this.model,
			messages: [
				{ role: 'system', content: this.opts.summarizePrompt || '把以下对话压缩成摘要，必须保留：任务目标、已做出的决定及依据、关键数字、未完成事项。直接输出摘要内容。' },
				...messagesToSummarize,
			],
			tools: [],
		})
		const content = response.choices[0].message.content || ''
		const costTokens = (response.usage?.prompt_tokens || 0) + (response.usage?.completion_tokens || 0)
		console.log(`[compaction] 摘要成本：输入 ${response.usage?.prompt_tokens} + 输出 ${response.usage?.completion_tokens} = ${costTokens} tokens；原文 ${Math.round(getMessagesTokens(messagesToSummarize))} → 摘要 ${Math.round(estimateTokens(content))}`)
		// 角色选 user 而非再放一条 system：两条 system 相邻不同供应商合并行为不一致；
		// 且对话摘要本质是上下文信息不是系统指令。放在真实 user 问题之前，模型以最新 user 消息为准
		return { summaryMessage: { role: 'user', content: `【前情摘要】以下是之前对话的摘要，供参考：\n${content}` }, costTokens }
	}

	// 武器③：滑动窗口（轮粒度）。正常情况下 compaction 之后走不到这里，防御性兜底
	private applyWindow(messages: any[]): any[] {
		const { totalTokens, toolsDefTokens } = getContextTokens(messages, this.opts.toolsDef)
		if (totalTokens <= this.opts.budgetTokens) return messages

		const windowed: any[] = []
		let currentTokens = toolsDefTokens // 工具定义每次请求必发，和视图用同一套口径
		const systemMessage = messages.find((m) => m.role === 'system')
		if (systemMessage) {
			windowed.push(systemMessage)
			currentTokens += estimateTokens(systemMessage.content)
		}

		for (const turn of groupTurns(messages).reverse()) {
			if (currentTokens >= this.opts.budgetTokens) break
			const turnTokens = getMessagesTokens(turn.messages)
			if (currentTokens + turnTokens <= this.opts.budgetTokens || !windowed.some((m) => m.role === 'user')) {
				if (currentTokens + turnTokens > this.opts.budgetTokens) {
					console.warn(`[window] 最新轮 ${Math.round(turnTokens)} tokens 超预算，为保证有 user 消息仍保留（当前 ${Math.round(currentTokens + turnTokens)} / 预算 ${this.opts.budgetTokens}）`)
				}
				windowed.splice(1, 0, ...turn.messages) // 恒插在 system 后，倒序插入自然还原时间正序
				currentTokens += turnTokens
			} else {
				console.warn(`[window] 丢弃最旧轮（${Math.round(turnTokens)} tokens）：预算装不下了`)
				break
			}
		}
		console.log(`[window] ${messages.length} 条 → ${windowed.length} 条，估算 ${Math.round(currentTokens)} / 预算 ${this.opts.budgetTokens}`)
		return windowed
	}

	// 打表：视图的四桶占比 + 底账对照（看双账本工作状态）
	logBreakdown() {
		const { systemTokens, historyTokens, toolsDefTokens, toolsResTokens, totalTokens } = getContextTokens(this.view, this.opts.toolsDef)
		console.log('Context Breakdown:')
		console.log(`  System: ${Math.round(systemTokens)} tokens (${((systemTokens / totalTokens) * 100).toFixed(2)}%)`)
		console.log(`  History: ${Math.round(historyTokens)} tokens (${((historyTokens / totalTokens) * 100).toFixed(2)}%)`)
		console.log(`  Tools Definition: ${Math.round(toolsDefTokens)} tokens (${((toolsDefTokens / totalTokens) * 100).toFixed(2)}%)`)
		console.log(`  Tools Results: ${Math.round(toolsResTokens)} tokens (${((toolsResTokens / totalTokens) * 100).toFixed(2)}%)`)
		console.log(`  Total: ${Math.round(totalTokens)} tokens | 底账 ${this.ledger.length} 条（~${Math.round(getMessagesTokens(this.ledger))}）vs 视图 ${this.view.length} 条`)
	}
}
