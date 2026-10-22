/*
模块 10 §3：pipeline（流水线）——模式二：A 的产出是 B 的输入（骨架——两处学习核心你来填）

模式一句话：spawn + handoff 的线性缝合。上一段的结论作为下一段的交接物，一段一个干净窗口——
没有新原语，§1 的 spawn 原封不动，模式全部活在「怎么串」里。
血缘：08 planner 的 dependsOn 步间转交就是它（工具层转交 → 任务层转交）；§7 组合系统（研究员→写手）的地基。

本节两个学习核心（TODO）：
  ① 接口契约——段与段传什么、以什么形式传，钉死在任务书里：
     下游任务书要声明「你收到的上游交接物是什么、你要交出什么形状」——契约不写死，链条就靠运气
  ② 门检（quality gate）——上游产出不合格，下游硬吃还是打回？
     判据必须【机器可判且便宜】：条数 / 字数 / 格式正则——判的是形状，不是质量
     （「写得好不好」是 §6 critic 的活——判据里混进质量判断，gate 就成了廉价的 critic，两头不占）

金笔记：
  - 打回的成本 = 该段全价重跑（spawn 从零起跑）——门检只拦「下游没法用」的形状问题，不拦「不够好」
  - 失败短路：段挂了后面不再跑，final 带失败定位（空手 ≠ 消息丢失——§7 全链路失败传播的预演）
  - 每段都是短命 agent——§2「多派小的比让一个长跑便宜」的平方账教训，在 pipeline 里是默认形态
*/
import { spawn, type SpawnResult } from './spawn.ts'

// 门检打回的预算：为什么是 1——打回一次的成本是全段重跑，两次以上的循环是 §6 critic 的领地，
// 这里只修「形状不合」，不搞「质量拉锯」
const MAX_GATE_RETRIES = 1

export interface PipelineStage {
	name: string
	task: string // 任务书（静态字符串——接口契约声明在此：收到什么、交出什么形状）
	maxSteps?: number // 透传 spawn；失败探针的旋钮（1 = 必出假结论，验证短路）
	check?: (conclusion: string) => string | null // 门检：null = 放行；string = 打回理由（形状判据）
}

export interface StageResult extends SpawnResult {
	name: string
	gatePassed: boolean // 交出合格品 = ok 且门检通过（无门检视同通过）；失败短路时 false = 没跑门检的字面事实
	gateReason?: string // 打回未愈的理由——带标注放行时留痕
	retries: number // 打回重跑次数
}

export interface PipelineResult {
	stages: StageResult[]
	ok: boolean
	final: string // 末段结论，或失败定位
	promptTokens: number
	completionTokens: number
}

// ---------- TODO ①：demo 两段链的任务书（接口契约钉死在这） ----------
// 建议主题（可换）：技术摘要 → 新手科普（进料 DEFAULT_MATERIAL 是 §2 平方账的真数，自家数据当原料）。
//   段1（提炼）：收进料，交「3~5 条要点列表」——契约写清：纯要点、每条一行、不超过 5 条
//   段2（科普）：收段1要点，交「面向新手的一段话」——契约写清：一个自然段、150 字以内、不要列表格式
// 写法要点：任务书里的「输出形状」和 TODO ② 门检「检查的形状」要一一对应——契约说一套、门检查另一套 = 白写
export function buildDemoStages(): PipelineStage[] {
	const stage1: PipelineStage = {
		name: '提炼',
		task: '【TODO ① 你来写：交代任务 + 输入期望 + 输出契约】',
	}
	const stage2: PipelineStage = {
		name: '科普',
		task: '【TODO ① 你来写：交代任务 + 输入期望 + 输出契约】',
	}
	return [stage1, stage2]
}

// ---------- TODO ②：两段的门检（形状判据） ----------
// 示例方向（自己写，别照抄）：段1 要求「拆行后至少 3 行」——conclusion.split('\n').filter(去空行).length >= 3
//   段2 要求「不含列表标记」（- / 1. 开头）——形状判据要便宜且确定，一行能算完
// 提醒：判「至少 3 条」是形状；判「要点提炼得准不准」是质量——后者写不进 check，想想为什么
export type StageCheck = (conclusion: string) => string | null

export function buildDemoChecks(): [StageCheck, StageCheck] {
	const check1: StageCheck = (conclusion) => {
		// TODO ② 你来写：不合格返回打回理由字符串，合格返回 null
		return null
	}
	const check2: StageCheck = (_conclusion) => {
		return null
	}
	return [check1, check2]
}

// 流水线进料：§2 失控探针的真数——无 PII、无网络依赖、技术密度够摘要段摘
const DEFAULT_MATERIAL =
	'无 prompt caching 时，agent 每一步都把全部历史重发给模型：第 n 步的 prompt 里装着前 n-1 步的全部内容，token 消耗随步数平方增长。实测：跑满八步的子 agent 单次 prompt 3.2 万 token，三步早收口的只有九千。推论：把长任务拆成多个短命子 agent，比让一个 agent 长跑便宜——每段窗口只装该装的，历史不滚雪球。'

export async function runPipeline(stages: PipelineStage[], initialHandoff = ''): Promise<PipelineResult> {
	const results: StageResult[] = []
	let handoff = initialHandoff // 进料 = 第 0 号交接物
	for (const stage of stages) {
		let res = await spawn(stage.task, { handoff, maxSteps: stage.maxSteps })
		let retries = 0
		let gateReason: string | null = null
		// 门检-打回循环：形状不合格 → 带理由重跑一次；再不过 → 带标注放行（诚实降级，不硬停——
		// 下游收到的交接物带瑕疵标注，带着瑕疵工作，不是掩盖）
		while (res.ok) {
			gateReason = stage.check?.(res.conclusion) ?? null
			if (!gateReason || retries >= MAX_GATE_RETRIES) break
			retries++
			res = await spawn(`${stage.task}\n\n上一次产出被门检打回，理由：【${gateReason}】。请修正后重新交付。`, {
				handoff,
				maxSteps: stage.maxSteps,
			})
		}
		if (!res.ok) {
			// 失败短路：本段挂了（真异常/假结论），后面的段不再跑——final 带失败定位
			results.push({ ...res, name: stage.name, gatePassed: false, retries })
			const totals = sumTokens(results)
			return {
				stages: results,
				ok: false,
				final: `流水线在【${stage.name}】段失败：${res.error ?? res.conclusion}`,
				...totals,
			}
		}
		const gatePassed = gateReason === null
		const stageResult: StageResult = { ...res, name: stage.name, gatePassed, retries }
		if (!gatePassed) stageResult.gateReason = gateReason!
		results.push(stageResult)
		// 下一段交接物：过检交结论；未过检交结论 + 标注（§5 handoff「不传什么同样重要」的第一次实操）
		handoff = gatePassed ? res.conclusion : `${res.conclusion}\n【门检标注】上游产出未通过形状检查（${gateReason}），请基于现状工作并在产出中说明此项`
	}
	const totals = sumTokens(results)
	return { stages: results, ok: true, final: results[results.length - 1]?.conclusion ?? '', ...totals }
}

function sumTokens(results: StageResult[]): { promptTokens: number; completionTokens: number } {
	return {
		promptTokens: results.reduce((s, r) => s + r.promptTokens, 0),
		completionTokens: results.reduce((s, r) => s + r.completionTokens, 0),
	}
}

export function printPipelineResult(result: PipelineResult) {
	console.log('\n===== 流水线账单 =====')
	for (const s of result.stages) {
		const gate = s.ok ? (s.gatePassed ? '门检过' : `门检未愈（${s.gateReason}）`) : '未跑门检'
		console.log(
			`  ${s.name} [${s.ok ? '成功' : '失败'}｜${gate}｜打回 ${s.retries} 次] prompt ${s.promptTokens} / completion ${s.completionTokens} (${s.elapsedMs}ms)：${s.conclusion.slice(0, 40)}`,
		)
	}
	console.log(`合计：prompt ${result.promptTokens} / completion ${result.completionTokens}`)
	console.log(`\n=== 最终产出 ===\n${result.final}`)
}

// 冒烟口（花 GLM 配额）：
//   node 10-multi-agent/pipeline.ts
//   期望：两段各一次 spawn，段1 交要点列表、段2 交科普段落，门检全过（0 打回）
//   打回探针：把段1 的 check 写死板（如「必须恰好 3 条」——模型常给 4~5 条）→ 看带理由重跑
//   放行探针：把 check 写成不可能满足的自相矛盾（「至少 4 条且至多 2 条」）→ 看带标注放行，下游如实转述瑕疵
//   短路探针：给段1 加 maxSteps: 1 → 假结论 {error} → 失败短路，final 带失败定位
const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href
if (isMain) {
	console.log(`\n【流水线进料】\n${DEFAULT_MATERIAL.slice(0, 50)}…\n`)
	const checks = buildDemoChecks()
	const stages = buildDemoStages().map((s, i) => ({ ...s, check: checks[i] }))
	const result = await runPipeline(stages, DEFAULT_MATERIAL)
	printPipelineResult(result)
}
