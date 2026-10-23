/*
模块 10 §3：pipeline（流水线）——模式二：A 的产出是 B 的输入（①② 均已评审定稿，待探针）

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

// ---------- demo 两段链的任务书（接口契约钉死在这） ----------
// 写法要点：任务书里的「输出形状」和门检「检查的形状」一一对应——契约说一套、门检查另一套 = 白写
export function buildDemoStages(): PipelineStage[] {
	/* ---------- 你写的（原版——保留对照） ----------
	评审问题（按严重度）：
	① 「根据 stage1 的输出」——子 agent 看到的标签是「上游交接物」，不认识 stage1（§2 指代反例的任务层复发）
	② task 自包【】——renderBrief 已渲染 你的任务是：【…】，再包一层成双层壳
	③ 跨行模板字符串把源码缩进（tab）原样带进任务书
	④ 「纯要点」不可执行——契约词要能落到门检判据上
	亮点：stage2 把上游输出契约复述成输入期望——接口契约的正确直觉，优化版保留
	const stage1: PipelineStage = {
		name: '提炼',
		task: `【任务：根据输入的相关知识信息，提炼出要点。
		输入期望：关于需要知识的信息，可以是比较全面的，也可以是总结性的知识。
		输出契约：输出3~5 条要点列表，纯要点、每条一行、不超过 5 条
		】`
	}
	const stage2: PipelineStage = {
		name: '科普',
		task: `【任务: 根据stage1的输出，生成面向新手的科普性的一段话。
		输入期望: 3~5 条要点列表，纯要点、每条一行、不超过 5 条。
		输出契约：输出内容是面向新手的一段话，字数不要太多，限制在150字以内。不要列表格式。
		】`
	}
	return [stage1, stage2]
	---------- ZCode 优化版（三处改法：措辞对齐渲染标签 / 去自包壳 / join('\n') 去缩进） ---------- */
	const stage1: PipelineStage = {
		name: '提炼',
		// 契约钉到「行首 - 」这个精度，TODO ② 的 check1 就能一行判——契约精度 ↔ 门检便宜度
		task: [
			'任务：阅读上游交接物中的技术材料，提炼核心要点。',
			'输入期望：一段技术材料。你收到的就是全部输入，不需要也无法补充。',
			'输出契约：3~5 条要点，每条一行、行首用「- 」；不要引言、不要总结句。',
		].join('\n'),
	}
	const stage2: PipelineStage = {
		name: '科普',
		task: [
			'任务：把上游交接物中的要点列表，转写成编程新手能懂的一段科普。',
			'输入期望：3~5 条技术要点（上游已提炼，你只负责转译，不要重新提炼）。',
			'输出契约：一个自然段、不超过 150 字（中英文都按字符计，含标点）；不要列表格式；术语第一次出现时顺带一句解释。',
		].join('\n'),
	}
	return [stage1, stage2]
}

// ---------- 两段的门检（形状判据） ----------
// 金笔记：判「至少 3 条」是形状；判「要点提炼得准不准」是质量——后者写不进 check（§6 critic 的领地）
export type StageCheck = (conclusion: string) => string | null

export function buildDemoChecks(): [StageCheck, StageCheck] {
	/* ---------- 你写的（原版——保留对照） ----------
	评审问题（按严重度）：
	① >max 分支的打回理由复制自 <min——都报「少于 3 条」。打回理由是重跑的方向盘，方向报反 =
	   在错误诊断上烧一次全价重跑（理由会被注入任务书，是模型下一轮的输入，不是日志）
	② check2 判段落数没滤空行——结尾一个 '\n' → ['…',''] 算 2 段 → 冤枉打回；check1 滤了、
	   check2 没滤：同一个坑修一处漏一处，滤空行提成共用函数
	③ 「第${i}条」从 0 起——路标按读者（模型）的数数习惯写，+1
	④ 契约「150 字」vs 判据 length（150 字符）单位不齐——中英混排偏严。答案（注释里那问）：
	   不用单词数（split 空格对中文无效、分词器引依赖）——契约把「字」定义成字符，两端一把尺
	const check1: StageCheck = (conclusion) => {
		// ② 你来写：不合格返回打回理由字符串，合格返回 null
		// 1. 3-5条 不包含空行
		const list = conclusion.split('\n').filter(item => item.trim())
		const min = 3, max = 5
		if (list.length < min) {
			return `输出的结果少于${min}条，应该返回 ${min} - ${max} 条数据`
		}
		if (list.length > max) {
			return `输出的结果少于${min}条，应该返回 ${min} - ${max} 条数据`
		}
		// 2. 以 '- ' 开头
		for (let i =0, len = list.length; i < len; i++) {
			if (!list[i].startsWith('- ')) {
				return `第${i}条未按 '- ' 开头， 所有的条目都应该以 '- ' 开头`
			}
		}
		return null
	}
	const check2: StageCheck = (conclusion) => {
		// 检查字数为150字(英文是不是要用单词数？)以内，段落数为1段
		const maxStrLen = 150
		if(conclusion.length > maxStrLen) {
			return `输出字数不能超过${maxStrLen}`
		}
		const maxP = 1
		if (conclusion.split('\n').length > maxP) {
			return `输出结论不能超过${maxP}段`
		}
		return null
	}
	return [check1, check2]
	---------- ZCode 优化版 ---------- */
	// 滤空行共用小函数（② 的修法）：check1/check2 都要「按行看形状」，空行不是内容
	const nonEmptyLines = (s: string): string[] => s.split('\n').filter((l) => l.trim())
	// 打回理由三要素：方向 + 实测值 + 修法——模型拿到的是可执行的修正信息，不是抽象抱怨
	const check1: StageCheck = (conclusion) => {
		const lines = nonEmptyLines(conclusion)
		const MIN = 3
		const MAX = 5
		if (lines.length < MIN || lines.length > MAX) {
			return `现在是 ${lines.length} 条，应为 ${MIN}~${MAX} 条（每条一行）`
		}
		// 不 trim 再判——「行首」就是第 0 个字符，先 trim 等于偷偷放行缩进行（判据与契约同侧的严格）
		const bad = lines.findIndex((l) => !l.startsWith('- '))
		if (bad !== -1) {
			return `第 ${bad + 1} 条未以「- 」开头（现状：${lines[bad].slice(0, 20)}）——每条行首用「- 」`
		}
		return null
	}
	const check2: StageCheck = (conclusion) => {
		// 段落数判据顺带拦住「列表格式」（列表必然多行）——覆盖成立但是巧合不是设计，改判据时记得这层
		const paragraphs = nonEmptyLines(conclusion)
		// 空结论守卫：单测逼出的缺口——滤完空行 0 段会从「段落数 ≤1」指缝里漏过去（check1 靠 0<MIN 免费拦住，这没有）
		if (paragraphs.length === 0) return '结论为空——空手不是合格品（§1 失败传播「空手」入口在这里被拦下）'
		if (paragraphs.length > 1) return `现在是 ${paragraphs.length} 段，应为 1 个自然段（含结尾换行不算段）`
		if (conclusion.length > 150) return `现在 ${conclusion.length} 字符，超过 150（契约单位=字符）——请删减`
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
		// 段内全账（实测抓的 bug）：打回重跑每一发的钱/耗时都累计——只记最后一发，
		// 首发的账就从流水线上蒸发（「花掉的钱不因打回而看不见」，和 spawn catch 同一条戒律）
		let stagePrompt = 0
		let stageCompletion = 0
		let stageElapsed = 0
		const charge = (r: SpawnResult) => {
			stagePrompt += r.promptTokens
			stageCompletion += r.completionTokens
			stageElapsed += r.elapsedMs
		}
		let res = await spawn(stage.task, { handoff, maxSteps: stage.maxSteps, tools: [] })
		charge(res)
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
				tools: [],
			})
			charge(res)
		}
		if (!res.ok) {
			// 失败短路：本段挂了（真异常/假结论），后面的段不再跑——final 带失败定位
			results.push({ ...res, name: stage.name, gatePassed: false, retries, promptTokens: stagePrompt, completionTokens: stageCompletion, elapsedMs: stageElapsed })
			const totals = sumTokens(results)
			return {
				stages: results,
				ok: false,
				final: `流水线在【${stage.name}】段失败：${res.error ?? res.conclusion}`,
				...totals,
			}
		}
		const gatePassed = gateReason === null
		const stageResult: StageResult = { ...res, name: stage.name, gatePassed, retries, promptTokens: stagePrompt, completionTokens: stageCompletion, elapsedMs: stageElapsed }
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
