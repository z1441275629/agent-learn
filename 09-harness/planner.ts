/*
模块 08 主菜：planner-executor 调度层（骨架）

分界线（和 agent.ts 的分工）：
- agent.ts 的 agentLoop = 裸 ReAct 循环：验收实验的对照组 + 每步的执行器，循环本体不动
- planner.ts（本文件）= 调度层：出图 → 打勾 → 失败重试 → 卡死重画图。只编排循环，不实现循环

任务清单（①~⑤ 是学习核心，你来填；schema / renderPlan / checkpoint 我写好了）：
① generatePlan    一次 LLM 调用出整张计划（zod 校验 + 一轮自修）
② runnableSteps   从依赖图推「现在能跑哪些」
③ runStep         跑一个步骤（子 agent + 步间上下文交接 + 成败判定）
④ executePlan     主循环：打勾推进、失败重试、卡死 replan、replan 熔断
⑤ replan          带着进度和失败原因重画图（保住 done 的步骤）

用法：WRITE_STRATEGY=A node 08-planner/planner.ts "北京今天下雨吗？..."
（为什么建议 WRITE_STRATEGY=A：见 executePlan 里的金笔记①——B 钩子挂在「会话结束」，
多步计划里「会话」的边界变了）

四个坑预告（踩实了记 PITFALLS）：
- 计划漂移：注入的计划对模型只是建议——判定成败别信「模型说完成了」
- 过度规划：3 步的事规划成 15 步，每步都是失败机会——generatePlan 提示词要压步数
- replan 套娃：重规划失败 → 再重规划 → 无限循环。熔断先写，replan 后写
- 非幂等重试：write_memory 重试一遍 = 记忆写两遍（07 审计日志就是证据）。重试前先问：这工具重跑安全吗
*/
import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { agentLoop, createAgent, client, MODEL, parseModelJson } from './agent.ts'
import type { ChatCompletionMessageParam } from 'openai/resources'
import { truncateToolResult } from './context.ts'

// ---------- 计划的形状 ----------
// 三个设计决策（想通再动手，比代码值钱）：
// - dependsOn 是 id 数组 → §3 并发时「哪些步骤能并行」直接从依赖图推出来，不用另写结构
// - status/retries 进 schema → 计划一个对象走天下，JSON.stringify 落盘就是天然检查点（§5 白送）
// - .default() 让模型少填也能过 → zod 防的是结构崩，不是逼模型填表
export const PlanStepSchema = z.object({
	id: z.number().int(),
	description: z.string().min(1),
	dependsOn: z.array(z.number().int()).default([]),
	status: z.enum(['pending', 'running', 'done', 'failed']).default('pending'),
	retries: z.number().int().default(0), // executor 私有计数，模型不用填
})
export const PlanSchema = z.object({
	goal: z.string(),
	steps: z.array(PlanStepSchema).min(1),
})
export type PlanStep = z.infer<typeof PlanStepSchema>
export type Plan = z.infer<typeof PlanSchema>

// 计划渲染成注入文本：✓ done / □ pending / ▶ running / ✗ failed
// 「计划常驻上下文」的钉子——和 07 的索引常驻是同一个模式：摘要常驻、正文按需
export function renderPlan(plan: Plan): string {
	const ICON: Record<PlanStep['status'], string> = { pending: '□', running: '▶', done: '✓', failed: '✗' }
	const lines = plan.steps.map((s) => `  ${ICON[s.status]} [${s.id}] ${s.description}${s.dependsOn.length ? `（依赖 ${s.dependsOn.join(', ')}）` : ''}`)
	return [`目标：${plan.goal}`, ...lines].join('\n')
}

// 检查点（§5 了解级的落地）：status 在 schema 里 → 序列化即检查点，每次状态变化落一次盘
// resume（记在 TUTORIAL §5 已知边界，未实施）：L1 计划级 = checkpoint 变 {plan, stepResults} 信封
// + 启动读档（running→pending 复位、done 跳过、Map 还原）；L2 步骤级 = runStep 传 sessionId 走 §5 半截续跑
// 金笔记：恢复时绝不能重跑 done 的步骤——非幂等副作用会翻倍（07 的并集合并救得了内容，救不了重复调用）
const CHECKPOINT = path.resolve(import.meta.dirname, 'plan-checkpoint.json')
async function saveCheckpoint(plan: Plan): Promise<void> {
	await fs.writeFile(CHECKPOINT, JSON.stringify(plan, null, 2))
}

// ---------- ① 出图 ----------
// 07 #18 的双保险原样上岗：提示词写「纯 JSON」+ parseModelJson 剥围栏。
// zod 是新增的第三层：safeParse 失败别直接扔——把 zod 错误信息喂回去让它自修一轮
// （想想喂什么：原始输出 + 错误列表，一次修复调用；自修还失败才大声 throw）
export async function generatePlan(task: string): Promise<Plan> {
	// 1. system 提示词：planner 角色；输出 {"goal", "steps":[{"id", "description", "dependsOn"}]}；
	//    压步数：「步骤尽量少，3~6 步为佳，只拆真正需要工具/检索的步骤」
	// 2. client.chat.completions.create（tools: []——planner 只出图不调工具）
	// 3. parseModelJson → PlanSchema.safeParse → 失败喂错误自修一轮 → 还失败 throw
	const systemPrompt = `你是一个planner角色，善于将用户的复杂任务拆分成多步来完成。输出纯JSON，格式  {"goal", "steps":[{"id", "description", "dependsOn"}]} ，请注意steps中的id是int number类型，不是string，不要输出代码块那种展示的格式
	步骤尽量少，3~6 步为佳，只拆真正需要工具/检索的步骤。`
	const messages: ChatCompletionMessageParam[] = [
		{ role: 'system', content: systemPrompt },
		{ role: 'user', content: task },
	]

	let requestTimes = 0
	const AllowPlanRetryTimes = 1 // 可以提取到配置项中

	const rqPlan = async (): Promise<Plan> => {
		const response = await client.chat.completions.create({
			model: MODEL,
			messages,
			tools: [],
		})
		console.log(`生成计划消耗的真实token: `, response.usage?.prompt_tokens)
		requestTimes++
		const messageContent = response.choices[0].message?.content
		const planJson: Plan = parseModelJson(messageContent)
		const { success, data, error } = PlanSchema.safeParse(planJson) // 返回 {success, data|error}

		if (success) {
			return data
		} else {
			// 达到允许重试次数上限
			if (requestTimes > AllowPlanRetryTimes) {
				throw new Error(`生成计划失败，错误：${error}`)
			}
			console.log(`生成计划失败，正在第${requestTimes}次重试`)
			// 将错误拼接到消息中发给模型
			messages.push({ role: 'assistant', content: '上一步模型输出信息：' + messageContent })
			const errorMsg = error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
			messages.push({ role: 'user', content: errorMsg.join('; ') })
			console.log('首调原文:', messageContent, '错误:', errorMsg)
			return rqPlan()
		}
	}

	return rqPlan()
}

// ---------- ② 依赖图 ----------
// 「现在能跑哪些」= pending 且 dependsOn 里的 id 全部 done。
// 返回数组而不只返回一个——§3 并发的接口现在就留好，MVP 里取 [0] 串行跑
// （先串行立住正确性，再换并发测加速比——单变量实验的老规矩）
export function runnableSteps(plan: Plan): PlanStep[] {
	const stepMap = new Map(plan.steps.map((item) => [item.id, item]))
	const res: PlanStep[] = []
	for (const item of plan.steps) {
		if (item.status === 'pending' && item.dependsOn.every((id) => stepMap.get(id)?.status === 'done')) {
			res.push(item)
		}
	}
	return res
}

// ---------- ③ 跑一步 ----------
// 步间上下文交接是 plan-and-execute 的命脉：每步是独立会话（各自的 ledger），
// 步与步互相看不见——step 3 要用 step 2 的查询结果，必须显式转交。
// 对比：单循环 ReAct 天然共享 ledger，这是它唯一的信息优势，交接设计要补上这个差
export async function runStep(plan: Plan, step: PlanStep, stepResults: Map<number, string>): Promise<{ ok: boolean; summary: string }> {
	// 1. systemExtra = `<plan>…</plan>` —— 带勾的最新地图常驻 system（标签由注入方自带：
	//    §5 定界符规矩——拼接处只管拼，边界谁的内容谁负责）
	// 2. task = 本步骤指令 + 依赖步骤的结果摘要（只带 dependsOn 指到的，截断防膨胀——truncateToolResult 可复用）
	// 3. const ctx = await createAgent(task, { systemExtra }) → agentLoop(ctx)
	// 4. 成败判定（金笔记：agentLoop 不抛错 ≠ 步骤成功——返回值是模型的话，不是验收。
	//    MVP 启发式：返回含 '"error"' = 失败；进阶：加一次 judge 调用，让另一个上下文核对目标）
	const systemExtra = `<plan>\n当前计划：\n${renderPlan(plan)}\n</plan>`

	const dependsOnTexts = step.dependsOn
		.map((stepId) => {
			return `【id为${stepId}的执行结果是${truncateToolResult(stepResults.get(stepId) || '')}】`
		})
		.join('\n')
	const task = `本步骤指令：${step.description},依赖列表为：${JSON.stringify(step.dependsOn)}， 依赖的执行结果：${dependsOnTexts}`

	// 工具面有意全量：planner 的执行 agent 是真干活的（天气/算数/笔记/记忆都可能用），全量是选择而非默认
	const ctx = await createAgent(task, { systemExtra })
	try {
		// 模型调用成功，也可能是失败（比如：达到最大步数，没有真正的把任务完成），让另一个模型判断是否成功
		const res = await agentLoop(ctx)
		return {
			ok: !res.includes('error'),
			summary: res,
		}
	} catch (err: any) {
		// 模型调用失败一定是失败
		return {
			ok: false,
			summary: err?.message || '',
		}
	}
}

// ---------- ④ 主循环 ----------
const MAX_RETRIES = 2 // 同一步骤重试上限（重试前想幂等——坑预告④）
const MAX_REPLANS = 3 // replan 熔断：重规划本身连续失败就停，别无限套娃（坑预告③）
export async function executePlan(task: string): Promise<string> {
	const stepResults = new Map<number, string>() // 步间交接的载体，executePlan 拥有它
	let plan = await generatePlan(task)
	console.log(`========计划=========\n ${JSON.stringify(plan, null, 2)}\n`)
	let replans = 0
	const startTime = new Date()
	while (true) {
		const runnable = runnableSteps(plan)
		// - 空 && 全 done → 汇总 stepResults 出最终报告（报告也是一次组装，别再调模型也行）
		// - 空 && 有 failed → 卡死：replans < MAX_REPLANS ? plan = await replan(...) : 返回失败报告
		if (!runnable.length) {
			// 出循环的条件全在这里
			// 1. 全done 完美完成任务
			if (plan.steps.every((item) => item.status === 'done')) {
				// 汇总 stepResults 出最终报告（报告也是一次组装，别再调模型也行）
				const stepDescription = [...stepResults.entries()].map(([stepId, stepRes]) => `【stepId: ${stepId}, stepResult: ${stepRes}】`).join('\n')
				console.log(`\n\n计划执行时间：${new Date().getTime() - startTime.getTime()}\n`)
				return '所有步骤执行成功，结果如下：\n' + stepDescription
			}
			// 2. 有failed 重试/出失败报告
			if (plan.steps.some((item) => item.status === 'failed')) {
				if (replans < MAX_REPLANS) {
					replans++
					console.log(`\n第${replans}次重新出计划\n`)
					// 把所有失败步骤的描述汇总成reason
					const res = plan.steps
						.filter((item) => item.status === 'failed')
						.map((item) => {
							return `【步骤Id: ${item.id}，状态：失败，结果描述：${stepResults.get(item.id)}】`
						})
					const reason = res.join('\n')
					plan = await replan(task, plan, reason)
					console.log(`========新计划=========\n ${JSON.stringify(plan, null, 2)}\n`)
					continue
				} else {
					// 返回失败报告
					const res = plan.steps.map((item) => {
						return `【步骤Id: ${item.id}，状态：${item.status}，结果描述：${stepResults.get(item.id)}】`
					})
					console.log(`\n\n计划执行时间：${new Date().getTime() - startTime.getTime()}\n`)
					return res.join('\n')
				}
			}
			// 3. runnable 为空、没 failed、也没全 done
			// 悬空依赖/成环, 比如模型把 dependsOn 写了个不存在的 id（[99]），或依赖成环（1→2→1）。这些步骤永远 pending
			if (replans < MAX_REPLANS) {
				replans++
				console.log(`\n第${replans}次重新出计划\n`)
				// 把所有失败步骤的描述汇总成reason
				const reason = `请检查是否有循环依赖或者依赖了步骤中不存在的id`
				plan = await replan(task, plan, reason)
				console.log(`========新计划=========\n ${JSON.stringify(plan, null, 2)}\n`)
				continue
			} else {
				// 返回失败报告
				const res = plan.steps.map((item) => {
					return `【步骤Id: ${item.id}，状态：${item.status}，结果描述：${stepResults.get(item.id)}】`
				})
				return '模型卡死，没有pending中的任务，也没有全部完成，也没有失败的任务，个步骤结果如下：\n' + res.join('\n')
			}
		}

		const runOneStep = async (step: PlanStep) => {
			console.log(`▶ [计划步骤 ${step.id}] 开始`)
			const { ok, summary } = await runStep(plan, step, stepResults)
			console.log(`■=========单步执行结果==========\n id: ${step.id}, ok: ${ok}, summary: ${summary} \n`)
			// ok → step.status = 'done'; stepResults.set(step.id, summary)
			// !ok → step.retries++ ≥ MAX_RETRIES ? (step.status = 'failed') : (step.status = 'pending') // 放回待重跑
			if (ok) {
				step.status = 'done'
				stepResults.set(step.id, summary)
			} else {
				if (step.retries >= MAX_RETRIES) {
					step.status = 'failed'
				} else {
					console.log(`===========步骤重试=========\n  id: ${step.id}, summary: ${summary} \n`)
					step.retries++
					step.status = 'pending' // 从running变成pending，下次取出来重新跑
				}
			}
		}

		const PARALLEL = process.env.PARALLEL !== '0'
		console.log(`=========当前${PARALLEL ? '并行' : '串行'}执行runnable步骤===========`)
		if (PARALLEL) {
			runnable.forEach((step) => (step.status = 'running'))
			await saveCheckpoint(plan)
			const batchRunSteps = runnable.map(runOneStep)
			await Promise.all(batchRunSteps)
			await saveCheckpoint(plan)
		} else {
			for (const step of runnable) {
				step.status = 'running'
				await saveCheckpoint(plan)
				await runOneStep(step)
				await saveCheckpoint(plan)
			}
		}
	}
	
	//
	// 金笔记①（钩子粒度）：WRITE_STRATEGY=B 时这里有语义 bug——extractMemories 挂在每次
	//   agentLoop 结束，多步计划被抽取 N 遍（去重兜着不出错，但费钱且语义怪）。「会话结束」
	//   的钩子遇到「一个任务 = N 次会话」就错位——钩子的粒度要跟任务边界对齐：
	//   planner 模式用 A，或把 B 钩子上提到 executePlan 尾部（拿全部 step ledger 抽一次）
	// 金笔记②（并发 seam）：§3 = 把 runnable[0] 换成整批 Promise.all——但写类步骤并发互踩
	//   （07 的「Promise.all 并发写同名文件互相覆盖」注释就是预告），先读后写、写串行
}

// ---------- ⑤ 重画图 ----------
// replan 第一原则：保住已完成的进度。done 的步骤绝不重跑——不只是浪费，
// 非幂等步骤重跑 = 副作用翻倍（记忆写两遍、消息发两条）
export async function replan(task: string, plan: Plan, reason: string): Promise<Plan> {
	// 当前计划（含状态）+ 卡住原因喂回 planner；
	// 提示词明确「done 的步骤原样保留且保持 done，只调整剩余部分」；zod 校验同 ①
	const newTask = `之前的计划执行失败了, task: 【${task}】，计划内容：【${JSON.stringify(plan)}】，失败原因是：【${reason}】。
	你重新规划一下计划，原来steps中状态是 done 的原样保留且保持 done 状态，只调整剩余部分。`
	const newPlan = await generatePlan(newTask)
	// 代码级保证：旧计划里 done 的步骤，新计划中同 id 同描述的强制保持 done
	for (const old of plan.steps.filter((s) => s.status === 'done')) {
		const again = newPlan.steps.find((s) => s.id === old.id && s.description === old.description)
		if (again) again.status = 'done' // stepResults 里结果还在，依赖交接不受影响
	}

	return newPlan
}

// ---------- 入口 ----------
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
	// 默认任务故意复用 07 的经典 case（天气+算账+查笔记）：三个工具步骤 + 决策，
	// 和裸 ReAct 跑同一个任务——§6 对照实验的口径从这里就保持一致
	const task = process.argv[2] ?? '北京今天下雨吗？如果下雨，全家 7 口人每人一把 25 元的伞一共多少钱？先查我笔记里关于买伞的记录，再决定买不买'
	console.log(`\n【任务】${task}\n`)
	const t0 = Date.now() // §3 加速比测量：墙钟从任务开始计（含出图），两臂同一口径
	const report = await executePlan(task)
	console.log(`\n【${process.env.PARALLEL !== '0' ? '并行' : '串行'}臂】总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
	console.log('\n=== 最终报告 ===\n' + report)
}

// const plan = await generatePlan('北京今天下雨吗？如果下雨，全家 7 口人每人一把 25 元的伞一共多少钱？先查我笔记里关于买伞的记录，再决定买不买')
// console.log(JSON.stringify(plan))
// console.log(JSON.stringify(runnableSteps(plan), null, 2))
