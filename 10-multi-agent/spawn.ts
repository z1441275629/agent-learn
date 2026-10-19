/*
模块 10 §1：spawn 原语——五种编排模式的共同原子（骨架——两个学习核心你来填）

多 agent 的本质收益 = 上下文隔离 + 并行。spawn 是「隔离」的最小实现：
起一个子 agent（干净上下文）、给它任务书、拿回结论——主管的窗口里永远只落结论，
不落过程。§0 那句「子 agent 只回传结论」不是提示词修辞，是这个函数的返回类型。

复用地图（累积式第三次大考：07 记忆 → 08 调度 → 10 编排）：
  09 createAgent：干净上下文工厂（system 人设 + env 注入；user 位只放任务书）
  09 agentLoop：循环本体；dispatch 咽喉白送权限/hook/沙箱——子 agent 调工具同样过闸，
    主管不用重新操心中关村那五层壳（harness 的复利）
  onUsage 探针（本次顺手加进 AgentLoopOptions）：token 账本数据入口——
    §9 验收「×N 倍率实测」从这里收数

失败传播的三个入口（想全再写 TODO ②）：
  ① 真 异常：网络/API 层 rejection 会从 agentLoop 一路穿出来（循环约定「永不抛」管的是
     工具错误，管不了 HTTP 层）——try/catch 兜
  ② 假 结论：agentLoop 完整返回了，但内容是 {error:...} JSON（最大步数中止/模型未返回内容）
     ——parseModelJson 剥开看 .error（09 unwrap 循环的老经验）
  ③ 空 手：跑完了、没 error、但结论没营养（研究类任务常见：没查到）——机器判不了，
     error 字段留给调用方续判。三个入口全兜住，主管才敢放心派活
*/
import { createAgent, agentLoop, parseModelJson } from '../09-harness/agent.ts'
import { truncateToolResult } from '../09-harness/context.ts'

export interface SpawnResult {
	ok: boolean
	conclusion: string // 结论不是过程——主管窗口只落它；长度防线：任务书里跟模型约定 + 这里兜底截断
	promptTokens: number
	completionTokens: number
	elapsedMs: number
	error?: string // ok=false 必有：①原文 ②模型侧 error——喂给主管做 重试/换路/放弃 的决策
}

// TODO 你来写（~10 行）：任务书渲染——「上下文边界」四个字的实锤
// 1. 任务本体 + 可选上游交接物 handoff：只传「下游需要的」摘要，绝不传上游整本账——
//    边界松一格，隔离的收益就漏一分（主管窗口被上游过程污染 = 白付了多 agent 的钱）
// 2. 输出契约写进任务书：「只回传最终结论，不超过 N 字，不要过程叙述」——
//    模型不会自觉，契约（软）+ conclusion 截断（硬）双保险
// 3. 返回 string，它就是 createAgent 的 task 参数（子 agent 世界的全部输入）
export function renderBrief(task: string, handoff?: string): string {
	throw new Error('TODO renderBrief')
}

// spawn：起一个子 agent 干活，拿回结论 + 账单。
// 子 agent 的权限/沙箱/hook 由 09 dispatch 咽喉自动覆盖——这里不重复操心中关村的事
export async function spawn(task: string, opts?: { handoff?: string; systemExtra?: string; maxSteps?: number; budgetTokens?: number }): Promise<SpawnResult> {
	const t0 = Date.now()
	let promptTokens = 0
	let completionTokens = 0
	try {
		const ctx = await createAgent(renderBrief(task, opts?.handoff), { systemExtra: opts?.systemExtra, budgetTokens: opts?.budgetTokens })
		const raw = await agentLoop(ctx, {
			maxSteps: opts?.maxSteps,
			onUsage: (u) => {
				promptTokens += u.promptTokens
				completionTokens += u.completionTokens
			},
		})
		// TODO 你来写（~15 行）：失败传播 ② + 结论收口
		// ② 假结论：parseModelJson(raw)?.error 有值 → ok:false，error 带上原文（截断）——
		//    注意 parseModelJson 对纯文本返回 undefined，别把正常结论误判成失败
		// 结论侧：conclusion = raw；用 truncateToolResult 兜底截断（防一个话痨子 agent 撑爆主管窗口）
		// 返回 SpawnResult（ok:true）——token 账和 elapsed 照记
		throw new Error('TODO spawn 结论收口')
	} catch (err: any) {
		// ① 真异常：ok:false + error 原文——token 账照记（花掉的钱不因失败而看不见，×N 记账要的是全量真数）
		throw new Error('TODO spawn 异常兜底')
	}
}

// 直接跑的冒烟口（花 GLM 配额，跑不跑你定）：
//   node 10-multi-agent/spawn.ts "用一句话说明 echo 命令在 Windows cmd 里的用法"
// 期望：一个 SpawnResult 打印出来——结论一句话、token 账两栏、耗时；工具类任务可看 [step] 日志
const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href
if (isMain) {
	const task = process.argv[2] ?? '用一句话总结：多 agent 系统里 spawn 原语的职责是什么'
	console.log(`\n【spawn 任务】${task}\n`)
	const result = await spawn(task)
	console.log(`\n=== spawn 结果 ===`)
	console.log(JSON.stringify(result, null, 2))
}
