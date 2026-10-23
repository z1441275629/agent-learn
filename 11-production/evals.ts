/*
模块 11 §1：evals——评测集与跑分器（骨架——三个学习核心你来填）

「自己考自己」的防线从数据结构开始：Property 的判据锚【任务书契约】，不锚模型输出——
抄模型某次的输出当黄金标准 = 循环论证，分数再高只说明「和那天一样」，不说明「对了」。

免费/付费分层（§10 门检与 critic 分工的评测版）：
  纯函数性质（本文件）：零成本——形状/可溯性/失败语义/成本护栏
  语义性质（judge）：§2 上岗，接口不变——Property 就是它的挂点

评测集自身的账也要记：跑一次 = 每 case 一次产线运行——evals 不是免费的，
它的价格就是「多久跑一次」的决策依据（报告最后一行）。

本节 TODO：
  ① numbersTraceable——数字可溯：报告里每个数字必须能在该 case 的素材里找到（编造检测的机械化）
  ② reportShape——周报形状：一个自然段/150 字以内/无列表（§9 判据缺口的回收：挂评测集不挂 critic）
  ③ 薄料 case 补全 + 自己再想一个 case（什么输入值得进评测集？想清楚它考什么性质）
*/
import { runCompositeSystem, SOURCE_MATERIAL, type CompositeResult } from '../10-multi-agent/composite.ts'

export interface CheckResult {
	status: 'pass' | 'fail' | 'skip'
	note?: string
}
export interface Property {
	name: string // 判据名——锚到契约条款，让人一眼看出「凭什么这是对的」
	check: (r: CompositeResult) => CheckResult
}
export interface EvalCase {
	id: string
	description: string // 这个 case 考什么、来自哪次真实运行/探针——case 没有出身就不该进集
	topic: string
	source: string // 输入素材（变体 = 薄料/乱码/单节——§1 seam 的注入点）
	expectPass?: boolean // 期望结局；不填 = 通过/诚实失败都接受（判性质不判结局）
	properties: Property[]
}
export interface CaseReport {
	caseId: string
	passed: number
	failed: number
	skipped: number
	results: { property: string; status: string; note?: string }[]
	result: CompositeResult // 留给 §2 judge 复用——一次运行，两层判（免费先跑，judge 后跑）
}
export interface EvalReport {
	overall: { passed: number; failed: number; skipped: number }
	cases: CaseReport[]
	promptTokens: number // 评测集自身的价格
	completionTokens: number
}

// ---------- 免费性质（骨架已给四个机械判据——锚点都写在名字里） ----------

// 结局：case 声明了期望就判，没声明跳过（薄料「诚实即合格」——判性质不判结局）
export function expectOutcome(expected?: boolean): Property {
	return {
		name: `结局${expected === undefined ? '（未声明）' : expected ? '通过' : '不通过'}（case 声明）`,
		check: (r) =>
			expected === undefined
				? { status: 'skip', note: 'case 未声明期望结局' }
				: r.passed === expected
					? { status: 'pass' }
					: { status: 'fail', note: `期望 ${expected ? '通过' : '未通过'}，实际 ${r.passed ? '通过' : '未通过'}` },
	}
}

// 失败传播：短路必须带段名定位（§1「空手 ≠ 消息丢失」的评测化；研究段未失败则跳过）
export const failureCarriesLocation: Property = {
	name: '短路带定位（契约：final 带【研究员】段失败）',
	check: (r) =>
		r.research.ok
			? { status: 'skip', note: '研究段未失败' }
			: r.finalReport.includes('【研究员】段失败')
				? { status: 'pass' }
				: { status: 'fail', note: `final 未带定位：${r.finalReport.slice(0, 40)}` },
}

// 熔断诚实：写作段熔断必须带未解决项、交最后一稿（§6 诚实降级的评测化；未熔断跳过）
export const meltIsHonest: Property = {
	name: '熔断诚实（契约：最后一稿 + 未解决项清单）',
	check: (r) => {
		if (r.passed) return { status: 'skip', note: '未熔断' }
		if (!r.research.ok) return { status: 'skip', note: '研究段短路，非写作熔断' }
		return r.openIssues.length > 0 ? { status: 'pass' } : { status: 'fail', note: '熔断但零未解决项——装通过' }
	},
}

// 成本护栏：单次全账超界 = 结构异常的前兆（轮数失控/交接物膨胀）——阈值先拍脑袋，§8 闭环里用数据校
export function costGuard(maxPrompt = 12000, maxCompletion = 4000): Property {
	return {
		name: `成本护栏（prompt ≤${maxPrompt} / completion ≤${maxCompletion}）`,
		check: (r) =>
			r.promptTokens <= maxPrompt && r.completionTokens <= maxCompletion
				? { status: 'pass', note: `${r.promptTokens}/${r.completionTokens}` }
				: { status: 'fail', note: `${r.promptTokens}/${r.completionTokens} 超界——查轮数和交接物` },
	}
}

// ---------- TODO ① 你来写：数字可溯 ----------
// 判据锚：REPORT_TASK「数字直接用简报里的（源头是素材），不要自造」
// 输入：该 case 的素材。输出：Property——从 r.finalReport 提取全部数字，
// 每个都必须能在素材里找到（编造=有数字无出处）。
// 三个真实的坑（都来自本仓库实测数据）：
//   - 千分位：素材写 13,749，报告可能写 13749——两侧都要 normalize（剥逗号）再比
//   - 小数：51.1s、11724→7557 里的箭头——提取正则要吃小数点
//   - 这条判据是「机械化的编造检测」：§7 审校① 的事实性判据（一发真金白银）在这里变成零成本——
//     代价是它只判「数字有出处」，判不了「数字用得对不对」——判据边界面清楚

// ---------- TODO ② 你来写：周报形状 ----------
// 判据锚：REPORT_TASK「一个自然段，150 字以内；不要列表格式」——
// §9 的判据缺口（门检不验、critric 三条标准没有字数项，产线和基线双双超字数畅通无阻）在这里回收：
// 改进挂评测集不挂 criticPrompt——evals 管长期质量（每次改动都重判），critic 管单次运行
// 判什么：段落数（空行分）≤1；无列表行（以 - / * / 数字. 开头）；字数 ≤150

// ---------- 评测集 ----------
// case 1：全料正常路径（来自 §8 实测运行——出身：真实探针，不是拍脑袋）
export const CASE_FULL: EvalCase = {
	id: 'full',
	description: '全料六节素材——正常路径：结局应通过 + 全性质过',
	topic: '模块10 多Agent六节战果',
	source: SOURCE_MATERIAL, // import 而非复制——单一事实源（契约漂移的教训第三次用上）
	expectPass: true,
	properties: [
		expectOutcome(true),
		failureCarriesLocation,
		meltIsHonest,
		costGuard(),
		// TODO ①② 完成后挂进来：numbersTraceable(SOURCE_MATERIAL), reportShape
	],
}

// case 2：薄料（来自 §7 薄料探针——考「无料可核时是否诚实」）
export const CASE_THIN: EvalCase = {
	id: 'thin',
	description: '薄料素材——验诚实：不编造、失败带诊断；通过/熔断都合法（不声明 expectPass）',
	topic: '模块10 战果（薄料）',
	source: 'TODO ③：砍到两条（建议留带数字的），直接写字面量',
	properties: [
		// TODO ③：至少挂 numbersTraceable(你的薄素材) + meltIsHonest + failureCarriesLocation
		// 想清楚：薄料下哪些性质会被真正触发（skip 和 pass 不是一回事——被触发才算覆盖）
	],
}

// TODO ③ 后半：再想一个 case 进集（候选方向：乱码素材/A 版约束张力、单节素材、素材里混一条与主题无关的）——
// 进集标准：它考的性质是别的 case 考不到的，且出身说得清（来自哪次真实观察/担心什么退化）

// ---------- 跑分器 ----------
export async function runEvalSet(cases: EvalCase[]): Promise<EvalReport> {
	const report: EvalReport = { overall: { passed: 0, failed: 0, skipped: 0 }, cases: [], promptTokens: 0, completionTokens: 0 }
	for (const c of cases) {
		const result = await runCompositeSystem(c.topic, { source: c.source }) // 每 case 一次产线运行——评测集的价格单位
		const results = c.properties.map((p) => {
			const cr = p.check(result)
			return { property: p.name, status: cr.status, note: cr.note }
		})
		const passed = results.filter((x) => x.status === 'pass').length
		const failed = results.filter((x) => x.status === 'fail').length
		const skipped = results.filter((x) => x.status === 'skip').length
		report.cases.push({ caseId: c.id, passed, failed, skipped, results, result })
		report.overall.passed += passed
		report.overall.failed += failed
		report.overall.skipped += skipped
		report.promptTokens += result.promptTokens
		report.completionTokens += result.completionTokens
	}
	return report
}

export function printEvalReport(rep: EvalReport) {
	console.log('\n===== evals 跑分 =====')
	for (const c of rep.cases) {
		console.log(`\n[${c.caseId}] ${c.passed} 过 / ${c.failed} 挂 / ${c.skipped} 跳`)
		for (const r of c.results) {
			const mark = r.status === 'pass' ? '✓' : r.status === 'fail' ? '✗' : '−'
			console.log(`  ${mark} ${r.property}${r.note ? ` — ${r.note.slice(0, 50)}` : ''}`)
		}
	}
	const total = rep.overall.passed + rep.overall.failed
	console.log(`\n总分：${rep.overall.passed}/${total}（skip ${rep.overall.skipped} 不计分——「未触发」不是「通过」）`)
	console.log(`评测集自身的价格：prompt ${rep.promptTokens} / completion ${rep.completionTokens}——多久跑一次的决策依据`)
}

// 冒烟口（花 GLM 配额：每 case 一次产线运行；TODO 未填时薄料 case 空性质照跑——先验骨架）：
//   node 11-production/evals.ts
//   期望：全料 case 四性质过；TODO ①②③ 补齐后跑出完整分数
const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href
if (isMain) {
	console.log(`\n【evals §1】产线评测集 v1\n`)
	const rep = await runEvalSet([CASE_FULL]) // 先只跑全料省钱；补齐 case 后改为全量
	printEvalReport(rep)
}
