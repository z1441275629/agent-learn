/*
模块 10 §2：supervisor——主管分派模式

模式一句话：主管不干活，只拆活、派活、收活。它的全部能力 = 一个工具：dispatch_task。
与 08 planner 的血缘（想清楚差别再动手）：
  planner：开工前一次出整张图（zod schema），执行中只 replan——「先知」模式
  supervisor：每收一份结论再决定下一个派什么——「走一步看一步」的 ReAct，但作用在任务层
  （agentLoop 在工具层 ReAct，supervisor 在任务层 ReAct——同构，不同层）

上下文隔离的活证据就在这：子 agent 的 dispatch_task 返回值只有 conclusion（spawn 截断过），
主管的 ledger 里落的是结论不是过程——§0 说的「主管窗口不被污染」，工具返回类型就是闸门。

token 全账（§9 记账第一次实战）：主管自己的 usage（onUsage）+ 每个子 agent 的账（SpawnResult）
分两本记，isMain 汇总打印——×N 倍率从这里长出来。

权限注：dispatch_task 不在 permissions.json 里——auto 模式（你的 .env）未列出工具自动放行；
default 模式下无头跑会被拒——那时把它加进 allow 清单（派单本身无副作用，风险在子 agent 那层，
而子 agent 的工具全过 09 dispatch 咽喉——闸门在正确的层上，主管这层可以放心开）
*/
import { createAgent, agentLoop } from '../09-harness/agent.ts'
import { registerTool } from '../09-harness/tools.ts'
import type { ToolDef } from '../09-harness/type.ts'
import { spawn, type SpawnResult } from './spawn.ts'

// 派单预算：supervisor 最大的失控风险是无限派单（每次都「再查一个」）——
// 预算耗尽后 dispatch_task 返回 {error}，逼主管用手头结论直接作答（09 的大声报哲学：
// 不是悄悄禁用，是告诉它「没预算了，请收口」）
const MAX_DISPATCHES = 5

// ---------- 全账本 ----------
const account = {
	supervisor: { promptTokens: 0, completionTokens: 0 },
	children: [] as SpawnResult[],
}
export function resetAccount() {
	account.supervisor = { promptTokens: 0, completionTokens: 0 }
	account.children = []
}

// 主管人设——本节的灵魂提示词。四件套：角色认知（带具体反例）/ 派单纪律（从子 agent
// 视角讲隔离 + 指代反例）/ 停止契约（数字锚「1~3 单」比「够用就停」管用）/ 输出（标注结论来源）
export function supervisorPrompt(): string {
	const role = '角色认知：你是主管，负责分配任务，让其他子agent干活，你不要亲自干活，例如不亲自查资料、不算数、不写长文，你的唯一动作是 dispatch_task 派活。'
	const dispatchRule =
		'派单纪律：由于每个子agent只能看到你给他分配的任务，看不到其他agent的任务以及总任务，所以你要把任务拆成独立的任务分配。别写【查一下刚才那个】、【结合前面的结论】这类指代——子agent看不到你的上下文，自包含的任务书：目标 + 必要背景 + 期望的结论形式'
	const stopRule = '停止契约：当你有足够的信息回答问题后，就直接回答问题，不要再派任务求稳，因为再派任务比较费token。要崇尚节约。「通常 1~3 单足够，想派第 4 单时先自问是不是在求稳」'
	const output = '输出：最终答案要综合所有子 agent 的结论，标注哪些结论来自哪次派单。'
	return [role, dispatchRule, stopRule, output].join('\n')
}

// dispatch_task 的 impl——派单 + 熔断
// 1. 熔断：模块级计数器（别放 impl 里——每次调用重置）超 MAX_DISPATCHES →
//    返回 {error: '派单预算耗尽，请基于已有结论直接作答'}（错误是给主管的信息，它能看懂会收口）
// 2. 派单：spawn(args.task, { handoff: args.handoff })，结果推入 account.children
// 3. 返回 JSON.stringify({ ok, conclusion })——只回结论，账目走 account 不进主管上下文
let dispatchCount = 0
export const dispatchTaskTool: ToolDef = {
	name: 'dispatch_task',
	description: '派一个子 agent 执行任务并回传结论。任务书必须自包含（子 agent 看不到你的上下文）',
	parameters: {
		type: 'object',
		properties: {
			task: { type: 'string', description: '自包含的任务书：目标 + 必要背景 + 期望的结论形式' },
			handoff: { type: 'string', description: '可选：上游结论摘要——只传下游需要的，不传过程' },
		},
		required: ['task'],
	},
	maxResultTokens: 600, // 结论级返回——主管窗口的洁净度由这个数字把门
	impl: async (args) => {
		try {
			if (dispatchCount >= MAX_DISPATCHES) {
				return JSON.stringify({ error: '派单预算耗尽，请基于已有结论直接作答' })
			}
			dispatchCount++
			const subAgentRes = await spawn(args.task, { handoff: args.handoff })
			const { ok, conclusion } = subAgentRes
			account.children.push(subAgentRes)
			return JSON.stringify({ ok, conclusion }) // conclusion 在spawn返回的时候截断过了，这里不截断了
		} catch (err: any) {
			return JSON.stringify({ error: `派单失败，错误信息：${err?.message}` })
		}
	},
}

// 启动一次主管会话（注册工具在 import 时完成——09 的老模式）
registerTool('dispatch_task', dispatchTaskTool)
export async function runSupervisor(mission: string): Promise<{ answer: string }> {
	resetAccount()
	dispatchCount = 0
	// 主管上下文 = 09 人设/记忆/环境 + 主管人设（systemExtra 管子第三次复用）。
	// 工具面硬约束（§5 皮球探针的教训落地：提示词「唯一动作是派单」是软锚，工具面才是硬闸）：
	// 只挂 dispatch_task——主管想干别的活，物理上没有工具。§2 留的「真要硬约束该改哪」在此结案
	const ctx = await createAgent(mission, { systemExtra: supervisorPrompt(), tools: ['dispatch_task'] })
	const answer = await agentLoop(ctx, {
		tools: ['dispatch_task'],
		onUsage: (u) => {
			account.supervisor.promptTokens += u.promptTokens
			account.supervisor.completionTokens += u.completionTokens
		},
	})
	return { answer }
}

export function printAccount() {
	const childPrompt = account.children.reduce((s, c) => s + c.promptTokens, 0)
	const childCompletion = account.children.reduce((s, c) => s + c.completionTokens, 0)
	console.log('\n===== token 全账 =====')
	console.log(`主管：prompt ${account.supervisor.promptTokens} / completion ${account.supervisor.completionTokens}`)
	for (let i = 0, len = account.children.length; i < len; i++) {
		const { ok, promptTokens, completionTokens, elapsedMs, conclusion } = account.children[i]
		console.log(`  子agent${i + 1} [${ok ? '成功' : '失败'}] prompt ${promptTokens} / completion ${completionTokens} (${elapsedMs}ms)：${conclusion.slice(0, 40)}`)
	}
	console.log(`子agent 合计：prompt ${childPrompt} / completion ${childCompletion}（派单 ${account.children.length} 次）`)
	console.log(`全系统：prompt ${account.supervisor.promptTokens + childPrompt} / completion ${account.supervisor.completionTokens + childCompletion}`)
}

// 冒烟口（花 GLM 配额）：
//   node 10-multi-agent/supervisor.ts "武汉今天适合骑车吗？给个建议"
//   期望：主管派 1~2 单（天气/建议类）→ 综合作答；全账打印 ×N 的第一手数据
//   失控探针：给个「全面调研 XX」类任务——看熔断和停止契约谁先起作用
const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href
if (isMain) {
	const mission = process.argv[2] ?? '武汉今天适合骑车吗？给个建议'
	console.log(`\n【主管任务】${mission}\n`)
	const { answer } = await runSupervisor(mission)
	console.log(`\n=== 主管最终答案 ===\n${answer}`)
	printAccount()
}

// node 10-multi-agent/supervisor.ts "武汉今天适合骑车吗？给个建议"        # 常规：1~2 单收口
// node 10-multi-agent/supervisor.ts "全面调研一下目前主流的前端框架"      # 失控探针：看派单数停在哪

