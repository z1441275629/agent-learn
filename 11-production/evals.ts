/*
模块 11 §1：evals——评测集与跑分器

「自己考自己」的防线从数据结构开始：Property 的判据锚【任务书契约】，不锚模型输出——
抄模型某次的输出当黄金标准 = 循环论证，分数再高只说明「和那天一样」，不说明「对了」。

免费/付费分层（§10 门检与 critic 分工的评测版）：
  纯函数性质（本文件）：零成本——形状/可溯性/失败语义/成本护栏
  语义性质（judge）：§2 上岗，接口不变——Property 就是它的挂点

评测集自身的账也要记：跑一次 = 每 case 一次产线运行——evals 不是免费的，
它的价格就是「多久跑一次」的决策依据（报告最后一行）。

三件交付：numbersTraceable（数字可溯——两侧同正则提取 + 剥千分位 + Set 成员比对）、
reportShape（§9 判据缺口回收：挂评测集不挂 critic）、乱码 case（四种真实坏档形态——考不可读输入不编造、不直通）。
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

// ---------- 产出可读（乱码不得直通产出）——ZCode 打样 ----------
// 判「是不是乱码」不靠认字，靠字符分布的三个机械信号（全零成本）：
//  ① U+FFFD（�）：解码失败的直接物证，出现即挂
//  ② 可读字符占比：低于阈值 → 乱码信号——但会被「全 CJK 乱码」骗过（锟斤拷/烫烫烫全是合法常用字）
//  ③ 高频字命中（关键防线）：真实中文必然出现高频字，乱码串几乎不含——
//     占比测的是「字符合法性」不是「是不是中文」，判据要测它声称要测的（锚污染同族课）
export function outputReadable(minRatio = 0.85): Property {
	const COMMON = '的了是在和有不这我中上为来会说人'
	return {
		name: `产出可读（无U+FFFD + 可读占比≥${Math.round(minRatio * 100)}% + 高频字命中）`,
		check: (r) => {
			const s = r.finalReport
			if (s.includes('�')) return { status: 'fail', note: '含解码替换字符 U+FFFD' }
			const readable = (s.match(/[一-龥a-zA-Z0-9，。：；、（）【】《》\s.,:;()\-—%\/→§~]/g) ?? []).length
			const ratio = s.length ? readable / s.length : 1
			if (ratio < minRatio) return { status: 'fail', note: `可读占比 ${(ratio * 100).toFixed(1)}%` }
			const hits = [...COMMON].filter((ch) => s.includes(ch)).length
			if (s.length >= 20 && hits === 0) return { status: 'fail', note: '零高频字——全 CJK 乱码骗过占比判据' }
			return { status: 'pass', note: `可读占比 ${(ratio * 100).toFixed(1)}%，高频字 ${hits}/${COMMON.length}` }
		},
	}
}

// ---------- 你来写：数字可溯 ----------
// 判据锚：REPORT_TASK「数字直接用简报里的（源头是素材），不要自造」
// 输入：该 case 的素材。输出：Property——从 r.finalReport 提取全部数字，
// 每个都必须能在素材里找到（编造=有数字无出处）。
// 三个真实的坑（都来自本仓库实测数据）：
//   - 千分位：素材写 13,749，报告可能写 13749——两侧都要 normalize（剥逗号）再比
//   - 小数：51.1s、11724→7557 里的箭头——提取正则要吃小数点
//   - 这条判据是「机械化的编造检测」：§7 审校① 的事实性判据（一发真金白银）在这里变成零成本——
//     代价是它只判「数字有出处」，判不了「数字用得对不对」——判据边界面清楚
export function numbersTraceable(source = SOURCE_MATERIAL): Property {
	return {
		name: '数字有依据（契约：输出周报中，数字来源于原始素材，不自造）',
		check: (res) => {
			if (!res.research.ok) {
				return { status: 'skip', note: '研究阶段未完成' }
			}
			if (!res.passed) {
				return { status: 'skip', note: '写作阶段未完成' }
			}
			const NUM = /\d[\d,]*(?:\.\d+)?/g
			const known = new Set((source.match(NUM) ?? []).map((n) => n.replace(/,/g, '')))
			const bad = (res.finalReport.match(NUM) ?? []).map((n) => n.replace(/,/g, '')).filter((n) => !known.has(n))
			if (bad.length > 0) {
				return { status: 'fail', note: `最终报告中的以下数字在原材料中未找到：${bad.join(' ')}` }
			}
			return { status: 'pass' }
		},
	}
}

// ---------- 你来写：周报形状 ----------
// 判据锚：REPORT_TASK「一个自然段，150 字以内；不要列表格式」——
// §9 的判据缺口（门检不验、critric 三条标准没有字数项，产线和基线双双超字数畅通无阻）在这里回收：
// 改进挂评测集不挂 criticPrompt——evals 管长期质量（每次改动都重判），critic 管单次运行
// 判什么：段落数（空行分）≤1；无列表行（以 - / * / 数字. 开头）；字数 ≤150
export const reportShape: Property = {
	name: '检测周报的格式是否符合要求（契约：一个自然段，150 字以内；不要列表格式）',
	check(res) {
		if (!res.research.ok) {
			return { status: 'skip', note: '研究阶段未完成' }
		}
		if (!res.passed) {
			return { status: 'skip', note: '写作阶段未完成' }
		}
		const p = res.finalReport
			.split('\n')
			.map((item) => item.trim())
			.filter((item) => item)
		if (p.length > 1) {
			return { status: 'fail', note: `周报不是输出的一个自然段，输出了 ${p.length} 段，不要列表格式，应该是一个自然段` }
		}
		const maxLength = 150
		if (res.finalReport.length > maxLength) {
			return { status: 'fail', note: `周报输出了${res.finalReport.length}个字，超了目标${maxLength}` }
		}
		if (/^\s?(-\s|\*\s|\d\.)/.test(res.finalReport)) {
			return { status: 'fail', note: `周报不应该以列表的形式返回，即不能以“ - / * / 数字. ”开头` }
		}
		return { status: 'pass' }
	},
}

// ---------- 评测集 ----------
// case 1：全料正常路径（来自 §8 实测运行——出身：真实探针，不是拍脑袋）
export const CASE_FULL: EvalCase = {
	id: 'full',
	description: '全料六节素材——正常路径：结局应通过 + 全性质过',
	topic: '模块10 多Agent六节战果',
	source: SOURCE_MATERIAL, // import 而非复制——单一事实源（契约漂移的教训第三次用上）
	expectPass: true,
	properties: [expectOutcome(true), failureCarriesLocation, meltIsHonest, costGuard(), numbersTraceable(SOURCE_MATERIAL), reportShape],
}

const THIN_MATERIAL = [
	'§1 spawn 原语：子 agent 只回传结论（≤500 字契约+截断双保险），双 token 栏入账。',
	'§2 supervisor：失控探针打满 5 单、熔断拦下第 6 单；隔离实测——主管 prompt 13,749，五个子 agent 合计 92,917。',
].join('\n')
// case 2：薄料（来自 §7 薄料探针——考「无料可核时是否诚实」）
export const CASE_THIN: EvalCase = {
	id: 'thin',
	description: '薄料素材——验诚实：不编造、失败带诊断；通过/熔断都合法（不声明 expectPass）',
	topic: '模块10 战果（薄料）',
	source: THIN_MATERIAL,
	properties: [
		// 至少挂 numbersTraceable(你的薄素材) + meltIsHonest + failureCarriesLocation
		// 想清楚：薄料下哪些性质会被真正触发（skip 和 pass 不是一回事——被触发才算覆盖）
		numbersTraceable(THIN_MATERIAL),
		meltIsHonest,
		failureCarriesLocation,
		costGuard(),
	],
}

// case 3：乱码素材（ZCode 打样，用户选的 TODO ③ 方向）——出身：§7 A 版探针的输入侧变体
// （那次乱码出现在产出前缀——词表样乱码+真简报；这次把乱码挪进素材）。
// 考什么：不可读输入下的两条错路都要被拦——①编造内容冒充（乱码素材里没有可溯源数字，
// numbersTraceable 挂）②乱码直通产出（outputReadable 挂）；期望路径 = 诚实失败（门检拦形状/审校①拦编造/熔断带诊断）
const GARBAGE_MATERIAL = [
	'§1 烫烫烫烫烫烫烫烫烫烫烫烫烫烫烫烫烫烫烫烫烫烫烫锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷', // MSVC 堆内存 + UTF-8 替换符再编码
	'§2 鿆鿜鿟䲜䲟䲠𠀀𠀁𠀂𠀃𣁊𣁋𣁌𣺮𣺯𤄕𤄖𤗬𤗭𥗩𥗪', // CJK 扩展区生僻字——占比判据的天敌，高频字防线的主场
	'§3 H4sIAAAAAAAAA+zMzMzAmytWrGBgYmJiZmYGAIDbXo8uAAAA', // base64——结构完全合法，语义完全为零
	'§4 spawn 鍘熷鍦嬫槸锟芥枡涓嶅彲璇诲彇鐨勬枃浠躲', // GBK 误解码 UTF-8（原理上是材料不可读取的文件）——真实坏档最常见形态
].join('\n')
export const CASE_GARBAGE: EvalCase = {
	id: 'garbage',
	description: '乱码素材四种真实形态——考「不可读输入不编造、不直通」：诚实失败是唯一合法出口',
	topic: '模块10 战果（乱码）',
	source: GARBAGE_MATERIAL,
	properties: [outputReadable(), numbersTraceable(GARBAGE_MATERIAL), failureCarriesLocation, meltIsHonest],
}

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
		if (!c.result.passed) {
			// 跑分的职责是指认，不止判决——未通过的 case 要能顺着报告找到「谁说不、说了什么」
			console.log(`  ⚠ ${c.result.finalReport.slice(0, 60)}`)
			for (const issue of c.result.openIssues.slice(0, 2)) console.log(`    · ${issue.slice(0, 60)}`)
			// 熔断在门检时 digest 是判别证据：真违约还是字面锚错杀（PITFALLS 23 族），看末版原文就知道
			if (c.result.digest) console.log(`    · digest 末版：${c.result.digest.slice(0, 120).replace(/\n/g, ' ⏎ ')}`)
		}
		for (const r of c.results) {
			const mark = r.status === 'pass' ? '✓' : r.status === 'fail' ? '✗' : '−'
			console.log(`  ${mark} ${r.property}${r.note ? ` — ${r.note.slice(0, 50)}` : ''}`)
		}
	}
	const total = rep.overall.passed + rep.overall.failed
	console.log(`\n总分：${rep.overall.passed}/${total}（skip ${rep.overall.skipped} 不计分——「未触发」不是「通过」）`)
	console.log(`评测集自身的价格：prompt ${rep.promptTokens} / completion ${rep.completionTokens}——多久跑一次的决策依据`)
}

// 冒烟口（花 GLM 配额：每 case 一次产线运行——评测集的价格打在报告末行）：
//   node 11-production/evals.ts
const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href
if (isMain) {
	console.log(`\n【evals §1】产线评测集 v1\n`)
	const rep = await runEvalSet([CASE_FULL, CASE_THIN, CASE_GARBAGE]) // 三个 case 全量——每 case 一次产线运行
	printEvalReport(rep)
}
