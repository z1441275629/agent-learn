/*
模块 10 §5：handoff（交接）——模式四：会话控制权的移交（骨架——两个学习核心你来填）

模式一句话：前四种模式里子 agent 干完活就退场、结论回传主管——**控制权从不移动**；
handoff 是唯一一个把「会话本身」交出去的模式：A 判断自己不是合适人选 → 生成交接物 →
B 接着会话 → A 退场。用户后续的所有话都直接对 B 说，A 的窗口从此是历史。

对照实物：ZCode / Claude Code 的 subagent 转交（一个会话里 agent 说「这事交给专家」然后
专家接管对话流）——本模块前四种是 spawn 系（主管常驻），这一种是 handoff 系（主管离场）。

它几乎是纯提示词工程：没有新原语、没有新循环——09 的 agentLoop 原样跑，变的只是
「下一步用户的输入进谁的窗口」。学习核心全在两处：

本节两个学习核心（TODO）：
  ① 交接物怎么生成——A 退场前最后一次调用不是「干活」是「写移交材料」。
     用 ZCode 提示词的那句老话：移交 = 上下文边界的最后一次收紧
  ② 交接给 B 的东西是「干净的」还是「全套的」——这个模式最容易做错的选择题：
     把 A 的整本 ledger 倒给 B 看似贴心，实则是隔离白做（B 继承 A 的所有污染+平方账）；
     传太少又丢任务脉络。边界划在哪，是本节要记账的核心决策

金笔记：
  - handoff 和 spawn 的方向差：spawn 是「结论反向流回主管」（主管常驻），handoff 是「控制权正向流走」（主管离场）
  - 移交材料三选：① 用户原始诉求原文 ② A 的结论/中间产物 ③ 双份都要——多数场景要 ①+②，
    但 A 窗口里的探索过程（工具调用、试错）一律不传——过程是 A 的负债不是 B 的资产
  - 「不传什么」的证据链全在前四节：§2 平方账（过程会滚雪球）、§3 契约（下游只需要形状）、§4 占位文字不能当内容
  - 熔断依然要：A 可能无限「再想想」不交权、B 接手后可能判断「应该转回 A」踢皮球——两个方向都要预算
*/
import { spawn, type SpawnResult } from './spawn.ts'
import { createAgent, agentLoop } from '../09-harness/agent.ts'
import { registerTool } from '../09-harness/tools.ts'
import type { ToolDef } from '../09-harness/type.ts'

// A 的移交预算：判断「该转交」最多想几次（agentLoop 的 maxSteps 语义在本节复用为「移交预算」）
const MAX_HANDOFF_STEPS = 4

// ---------- A 的分诊人设 ----------
// ZCode 优化版（评审问题：① 模板字符串缩进污染第三次复发——跨行必 join('\n')；
// ② 指代失配——A 的世界里没有「B」只有 hand_off 工具，措辞对齐 agent 实际所见（§2 老坑换马甲）；
// ③ reason 字段补指引——那是给 B 的第一句话，不是日志。
// 保留的原版亮点：能力白名单给了可判的转交标准（皮球风险低）、红线一句到位）
export function triagePrompt(): string {
	/* ---------- 你写的（原版——保留对照） ----------
	return `你是一个分诊员，你能干的活是查询天气，进行数学运算。如果来了你不能干的活，就是你能力以外的任务，你可以转交给B，你能干的不要转交。
	移交时，你需要提供转交材料，通过调用 hand_off 工具实现转交，参数按工具要求的参数来。
	红线：不传你思考的过程、工具调用的结果等，只按 hand_off 工具要求的参数格式来传`
	---------- 优化版 ---------- */
	return [
		'角色：你是分诊员，只处理两类任务——查天气、数学运算。能做的自己做，做完直接回答用户。',
		'转交条件：用户诉求超出这两类（如代码审查、深度分析、写作），调用 hand_off 工具转交——这是你唯一的转交动作，能做的不要转。',
		'移交材料：调用 hand_off 时三个字段都要填——reason 写清「为什么这事超出你的能力」（这是接手者的第一句话，不是给人看的日志）；originalRequest 抄用户原话一字不改；conclusion 写你已有的判断，还没开始就写「尚未开始」。',
		'红线：不传你的思考过程、工具调用记录、试错经过——接手者只需要冷启动的最小集合。',
	].join('\n')
}

// hand_off 工具定义：A 的唯一「逃生舱」——调用它 = 生成移交材料 + 交出控制权
// args 就是移交包本身（结构即契约：字段名写在 parameters 里，A 照着装）
export interface HandoffPackage {
	reason: string // A 为什么转交（给 B 的第一句话——B 需要知道自己被卷进来的原因）
	originalRequest: string // 用户原始诉求原文（B 冷启动的锚——没有它 B 只能听 A 的转述）
	conclusion: string // A 已有的结论/中间产物（可以是「还没开始干，只有分类判断」）
}
export const handOffTool: ToolDef = {
	name: 'hand_off',
	description: '把会话控制权移交给专家 agent。调用即退场——之后用户直接与专家对话，你不再参与。',
	parameters: {
		type: 'object',
		properties: {
			reason: { type: 'string', description: '转交原因（给 B 的第一句话）' },
			originalRequest: { type: 'string', description: '用户原始诉求原文，一字不改' },
			conclusion: { type: 'string', description: '你已有的结论或中间产物；没有就写「尚未开始」' },
		},
		required: ['reason', 'originalRequest', 'conclusion'],
	},
	maxResultTokens: 200, // 工具返回值只进 A 的窗口（A 还要写最终告别语），移交包本体从 args 走——不占 A
	impl: async () => JSON.stringify({ status: '已交接——请向用户简要说明你已移交，之后不再发言' }),
}

// ---------- B 的冷启动任务书 ----------
// ZCode 优化版（评审问题：缩进污染同 ①；「遇到问题」措辞失真——A 可能尚未开始就转；
// 「A原来的任务是」改「用户诉求」——B 看到的主体是用户的活，不是 A 的活。契约句原样保留——写得好）
export function renderHandoffBrief(pkg: HandoffPackage): string {
	/* ---------- 你写的（原版——保留对照） ----------
	return `agent A处理任务时，遇到问题请求你继续处理。
	A原来的任务是 ${pkg.originalRequest}。
	A转交的原因是 ${pkg.reason}。
	A转交前得出的结论是 ${pkg.conclusion}。
	请你继续解决用户的问题。
	契约：你接手任务后，请礼貌的向用户自报家门，说一下你对问题的理解，让用户知道你在往对的方向走。
	`
	---------- 优化版 ---------- */
	return [
		`接手背景：分诊员无法处理这个诉求，已通过 hand_off 转给你。`,
		`用户诉求原文：【${pkg.originalRequest}】`,
		`转交原因：【${pkg.reason}】`,
		`分诊员已有的结论：【${pkg.conclusion}】`,
		'任务：接手这个诉求并给出解决。',
		'契约：接手第一句先向用户自报家门（你是谁、擅长什么），再复述你对诉求的理解让用户确认方向，然后开始解决。',
	].join('\n')
}

// ---------- demo 剧本 ----------
// A = 全科分诊（triage）：能答天气/算数这类小活；遇到代码审查类诉求 → hand_off
// B = 代码审查专家：接到移交包后接管会话
// 用两条不同诉求各跑一遍，看 A 在该转的转、不该转的自己答：
//   「武汉今天适合骑车吗」→ A 自己答（不转）
//   「帮我审查这段代码有没有并发问题」→ A 转 B（移交流）
const DEMO_A_PROMPT_EXTRA = triagePrompt

// B 的专家人设——handoff 的 B 之所以值得接权，靠的是被专门塑造的身份；按 09 的分层，
// 「你是谁」走 system 位（systemExtra），「发生了什么」走 user 位（移交包渲染的任务书）——两个位置别混
export const EXPERT_B_PROMPT = '你是资深代码审查专家，精通并发安全、类型系统与常见缺陷模式。审查时：先说结论，再逐条列问题（按严重度排序），每条带修改建议。不确定的地方明说不确定，不编造。'

// handoff 的实测骨架：A 跑一个带 hand_off 工具的 agentLoop，若 A 调用了 hand_off →
// 抓住 args 组装移交包 → 起 B（createAgent 干净窗口 + renderHandoffBrief 任务书）→
// B 跑 agentLoop 接管——控制权移交的完整路径。A 不调 hand_off = A 自己答完，不转（合法路径）
//
// 抓 hand_off 的手段（09 的 onToolCall 探针第二次实战）：A 的 agentLoop 里挂
// onToolCall: (name, args) => { if (name === 'hand_off') captured = args }——
// 工具白跑（返回告别语），args 已经被我们截获。A 循环结束后看 captured 有没有货。
export interface HandoffDemoResult {
	transferred: boolean // A 是否交权
	package?: HandoffPackage // 移交包（transferred 才有）
	aResult: SpawnResult | null // A 没转：A 的完整账（转了的话 A 的账在 ledger 手工记）
	bResult: SpawnResult | null // B 的账（transferred 才有）
	ledger: SpawnResult[] // 真账：谁跑过谁进账
}

// 你来跑的探针入口（isMain 里两条剧本二选一）——骨架先立型，TODO ①② 填完才真跑
export async function runHandoffDemo(userRequest: string): Promise<HandoffDemoResult> {
	const ledger: SpawnResult[] = []
	let pkg: HandoffPackage | undefined
	// A 舞台：09 全家桶 + hand_off 工具 + triagePrompt 人设
	registerTool('hand_off', handOffTool)
	const ctx = await createAgent(userRequest, { systemExtra: DEMO_A_PROMPT_EXTRA() })
	let aPrompt = 0
	let aCompletion = 0
	const raw = await agentLoop(ctx, {
		maxSteps: MAX_HANDOFF_STEPS,
		onToolCall: ({ name, arguments: args }) => {
			if (name === 'hand_off') pkg = JSON.parse(args) as HandoffPackage
		},
		onUsage: (u) => {
			aPrompt += u.promptTokens
			aCompletion += u.completionTokens
		},
	})
	// A 的账：无论转不转，A 跑过的钱都进 ledger（这里没有 spawn 帮我们记账——09 agentLoop 的账要自己经 onUsage 攒，§4 的 charge 思路降级手写）
	ledger.push({ ok: true, conclusion: raw, promptTokens: aPrompt, completionTokens: aCompletion, elapsedMs: 0 })
	if (!pkg) {
		// 未转：A 自己答完——合法路径，B 不出场
		return { transferred: false, aResult: ledger[0], bResult: null, ledger }
	}
	// 转了：B 冷启动接管——干净窗口（createAgent），任务书 = 移交包渲染（user 位），人设 = 专家 systemExtra（system 位）
	const b = await spawn(renderHandoffBrief(pkg), { systemExtra: EXPERT_B_PROMPT })
	ledger.push(b)
	return { transferred: true, package: pkg, aResult: null, bResult: b, ledger }
}

// 冒烟口（花 GLM 配额；TODO ①② 没填前 A 没有转交指令=永远不转，跑的是「未转」路径——零浪费验骨架）：
//   node 10-multi-agent/handoff.ts "武汉今天适合骑车吗？给个建议"        # 期望：不转，A 直接答
//   node 10-multi-agent/handoff.ts "帮我审查这段 TypeScript 代码有没有并发安全问题"   # 期望：转，移交包三字段齐
//   node 10-multi-agent/handoff.ts "9.9 和 9.11 哪个大？请说明理由"
//   皮球探针：TODO ① 写好后故意把转交条件写宽（什么都转）→ 看是否所有诉求都被转走（分诊失职）
//   红线探针：在 B 的产出里检查是否出现 A 过程的细节（如工具调用叙述）——出现=移交包超载，回头查 TODO ②
const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href
if (isMain) {
	const request = process.argv[2] ?? '武汉今天适合骑车吗？给个建议'
	console.log(`\n【用户诉求】${request}\n`)
	const result = await runHandoffDemo(request)
	console.log(`\n===== handoff 账单 =====`)
	console.log(`转交：${result.transferred ? `是——原因【${result.package?.reason}】` : '否（A 自己答）'}`)
	if (result.transferred) {
		console.log(`移交包：originalRequest【${result.package?.originalRequest}】`)
		console.log(`        conclusion【${result.package?.conclusion?.slice(0, 60)}】`)
		console.log(`\n=== B（专家）接手后 ===\n${result.bResult?.conclusion}`)
	} else {
		console.log(`\n=== A 直接作答 ===\n${result.aResult?.conclusion}`)
	}
	const p = result.ledger.reduce((s, r) => s + r.promptTokens, 0)
	const c = result.ledger.reduce((s, r) => s + r.completionTokens, 0)
	console.log(`\n真账：prompt ${p} / completion ${c}（${result.ledger.length} 个 agent 在场）`)
}
