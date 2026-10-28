// 模块 12 毕业项目：daily-brief 产线 v1——按订阅清单 fanout → researcher → writer → critic → 落盘
//
// 复用对照（毕业项目=组装手写件，按需组装）：
//   09 llm.ts 配置层     → 复用（平台无关这事它已解决；只 import client/MODEL，不引 agent.ts 五层壳）
//   10 composite 产线形状 → researcher(≈chargeR)/writer(≈chargeW)/critic(≈settle) 三角色 + 按主题 fanout(Promise.all)
//   08 zod 校验+自修一轮  → researcher 输出契约校验失败把错误喂回去重试一次（不是无限重试——烧钱上限）
//   08 花括号切片         → 剥 LLM 输出的 JSON（比剥 ```json 围栏鲁棒：围栏/寒暄/尾随句全剥，§2 增补复课教训）
//   06 输入侧筛选         → 每源 topN 进 prompt，上下文预算是钱
//   11 判据锚契约         → critic 程序断言优先（URL 必须真实来自原始池——防编造），LLM 质检只做辅助 verdict
//
// 跑法：node 12-capstone/daily-brief/pipeline.ts（烧 GLM 配额，每天 cron 一发 ≈ 6 次 LLM 调用）
import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { client, MODEL } from '../../09-harness/llm.ts'
import { fetchTopic, type RawItem } from './sources.ts'

const DIR = import.meta.dirname
const REPORTS = path.join(DIR, 'reports')
const today = () => {
	const d = new Date()
	const p = (n: number) => String(n).padStart(2, '0')
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// ---------- LLM 单发调用（无工具无循环——对照：spawn 的价值在「带工具委派」，纯文本变换不需要 09 五层壳） ----------
interface ChatResult { text: string; promptTokens: number; completionTokens: number; elapsedMs: number }
async function chat(
	system: string,
	user: string,
	opts?: { temperature?: number; thinking?: boolean }
): Promise<ChatResult> {
	const t0 = Date.now()
	// thinking 是 GLM 方言参数（对照 09 llm.ts THINKING_STYLE 的 openapi 风格）——默认不传走模型默认
	const body: any = { model: MODEL, temperature: opts?.temperature ?? 0.4, messages: [
		{ role: 'system', content: system },
		{ role: 'user', content: user },
	] }
	if (opts?.thinking !== undefined) body.thinking = { type: opts.thinking ? 'enabled' : 'disabled' }
	const res = await client.chat.completions.create(body)
	const u: any = (res as any).usage ?? {}
	return {
		text: res.choices[0]?.message?.content ?? '',
		promptTokens: u.prompt_tokens ?? 0,
		completionTokens: u.completion_tokens ?? 0,
		elapsedMs: Date.now() - t0,
	}
}

// 花括号切片：从模型输出里挖第一段平衡的大括号 JSON（模块 08 的保险，围栏/寒暄全免疫）
export function sliceJSON(text: string): string | null {
	const start = text.indexOf('{')
	if (start < 0) return null
	let depth = 0
	for (let i = start; i < text.length; i++) {
		if (text[i] === '{') depth++
		else if (text[i] === '}') {
			depth--
			if (depth === 0) return text.slice(start, i + 1)
		}
	}
	return null
}

// ---------- 账本（×N 账本格式：每阶段明细 + 总账——11 trace 的本地 JSON 同款纪律） ----------
export interface Ledger { calls: number; promptTokens: number; completionTokens: number; elapsedMs: number }
const ledger: Record<string, Ledger> = {}
function charge(stage: string, r: ChatResult) {
	const l = (ledger[stage] ??= { calls: 0, promptTokens: 0, completionTokens: 0, elapsedMs: 0 })
	l.calls++
	l.promptTokens += r.promptTokens
	l.completionTokens += r.completionTokens
	l.elapsedMs += r.elapsedMs
}

// ---------- researcher：抓源 → LLM 筛选打分（每主题一发，fanout 并行） ----------
const ResearcherOut = z.object({
	items: z
		.array(
			z.object({
				title: z.string(), // 英文原标题（原样保留——溯源）
				title_zh: z.string(), // 中文翻译标题（writer 直接可用——「附带模型翻译」在这完成）
				comment: z.string(), // 中文点评：这条对做 agent 开发的人为什么值得看
				url: z.string(),
			})
		)
		.min(1),
	digest: z.string(), // 本主题今日一句话总评
})
type ResearcherItem = z.infer<typeof ResearcherOut>['items'][number]

// 显式返回类型：联合字面量推断不穿 Promise.all——三个分支（空源/JSON 失败/成功）收进一个契约
export interface TopicResult {
	topic: { id: string; name: string; focus: string; hnQuery: string; githubQuery: string }
	items: ResearcherItem[]
	digest: string
	raw: number
	errors: string[]
}
async function researchTopic(topic: TopicResult['topic']): Promise<TopicResult> {
	const { items, errors } = await fetchTopic(topic.hnQuery, topic.githubQuery)
	if (items.length === 0) return { topic, items: [] as ResearcherItem[], digest: '', raw: 0, errors }

	// 06 输入侧筛选：原始池全量带上太贵也无用，截到 top25（HN 已按时间，GitHub 已按星）
	const pool = items.slice(0, 25)
	const listing = pool.map((it, i) => `${i + 1}. ${it.title}\n   ${it.meta}\n   ${it.url}`).join('\n')

	const system = `你是 AI 领域研究员，为一位正在转型 AI 工程师的前端开发者筛选每日情报。只从给定清单里选，绝不编造清单外的条目。`
	const user = `主题：【${topic.name}】（${topic.focus}）
过去两天该主题的候选条目：
${listing}

任务：选出 4~8 条对「学习 agent 开发 + 跟进工业界动态」最有价值的条目。噪声（营销稿、重复、纯吐槽）剔除。
每条给：英文原标题原样保留、中文翻译标题、中文点评（一两句：这条讲了什么、为什么值得看）。
最后给本主题今日一句话总评。
只输出 JSON：{"items":[{"title":"","title_zh":"","comment":"","url":""}],"digest":""}`

	// 08 模式：zod 校验失败 → 错误喂回去自修一轮（仅一轮——n=1 方差靠契约+重试兜，不无限烧）
	let parsed: z.infer<typeof ResearcherOut> | null = null
	let lastRaw = ''
	for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
		const r = await chat(system, attempt === 0 ? user : `${user}\n\n上一次输出不是合法 JSON 或字段缺失：${lastRaw.slice(0, 200)}。重新输出完整 JSON。`, {
			temperature: 0.3,
			thinking: false, // 筛选任务不需要深思，速度优先
		})
		charge(`researcher:${topic.id}`, r)
		const raw = sliceJSON(r.text)
		if (!raw) { lastRaw = r.text; continue }
		const check = ResearcherOut.safeParse(JSON.parse(raw))
		if (check.success) parsed = check.data
		else lastRaw = JSON.stringify(check.error.issues.slice(0, 3))
	}
	if (!parsed) return { topic, items: [] as ResearcherItem[], digest: `（researcher 两轮都没给出合法 JSON——主题降级空板块）`, raw: pool.length, errors }

	// 11 判据锚契约：URL 必须真实来自原始池——编造的链接在这里程序剪掉（业务正确性程序保证，不赌 LLM）
	const poolURLs = new Set(pool.map((p) => p.url))
	const verified = parsed.items.filter((it) => poolURLs.has(it.url))
	return { topic, items: verified, digest: parsed.digest, raw: pool.length, errors }
}

// ---------- writer：全主题汇总 → 中文日报 markdown ----------
async function writeReport(
	sections: { topic: { id: string; name: string }; items: ResearcherItem[]; digest: string }[],
	revision?: { issues: string[] }
): Promise<string> {
	const material = sections
		.map(
			(s) =>
				`## ${s.topic.name}\n总评：${s.digest}\n条目：\n${s.items
					.map((it) => `- ${it.title} | 译：${it.title_zh} | 点评：${it.comment} | ${it.url}`)
					.join('\n')}`
		)
		.join('\n\n')
	const system = `你是日报主编。输入是研究员按主题整理好的条目材料，你把它编成一份清爽的中文 markdown 日报。英文条目标题用「中文译名（英文原名）」并列呈现，保留全部链接。不编造材料外的事实和链接。`
	const user = `今天是 ${today()}。材料：
${material}

要求：
1. 一级标题「AI 情报日报 ${today()}」
2. 每个主题一个二级标题节，节首放该主题总评，条目用列表（链接放条目行内）
3. 末尾「今日总评」一段：跨主题串一遍今天最重要的 2~3 件事
4. 全文中文（条目英文原名除外），读者是在学 agent 开发的工程师
${revision ? `\n上一版被质检打回，问题：${revision.issues.join('；')}。这次针对性修正。` : ''}`
	const r = await chat(system, user, { temperature: 0.5, thinking: true }) // 成稿是内容质量关键一环，开思考
	charge('writer', r)
	return r.text
}

// ---------- critic：程序断言优先（11 教训：锚契约程序判，LLM judge 只做辅助） ----------
async function critique(
	markdown: string,
	sections: { topic: { id: string; name: string }; items: ResearcherItem[] }[],
	poolURLs: Set<string>
): Promise<{ pass: boolean; issues: string[]; score: number }> {
	const issues: string[] = []
	// 断言① 空板块：有原料的主题节必须在日报里出现
	for (const s of sections) if (s.items.length > 0 && !markdown.includes(s.topic.name)) issues.push(`缺「${s.topic.name}」节`)
	// 断言② 防编造：日报里所有 URL 必须来自原始池
	const urlsInReport = [...markdown.matchAll(/https?:\/\/[^\s)>\]]+/g)].map((m) => m[0].replace(/[.,;]$/, ''))
	const fabricated = urlsInReport.filter((u) => !poolURLs.has(u))
	if (fabricated.length) issues.push(`出现原始池外的链接：${fabricated.slice(0, 3).join(' , ')}`)
	// 断言③ 内容量下限（防空日报糊弄）
	if (markdown.length < 500) issues.push(`正文过短（${markdown.length} 字）`)
	// LLM 质检（辅助 verdict——程序断言全过才看它，权重只是「要不要打回重写」）
	if (issues.length === 0) {
		const r = await chat(
			`你是日报质检员。给这份日报打分（1~10）并给出改进意见。低于 7 分或有事实性问题判不过。只输出 JSON：{"score":0,"issues":[""],"pass":true}`,
			markdown,
			{ temperature: 0.1, thinking: false }
		)
		charge('critic', r)
		const raw = sliceJSON(r.text)
		if (raw) {
			const v = JSON.parse(raw)
			if (!v.pass || v.score < 7) issues.push(...(v.issues ?? [`质检分 ${v.score}`]))
		}
	}
	return { pass: issues.length === 0, issues, score: -1 }
}

// ---------- 落盘层：日报 + 当日状态 + 跨日汇总台账 ----------
// 三件套按日期/角色分家：日报 md 与 status 都带日期（同日重跑覆盖当日份，跨天不覆盖）；
// history.json 每次运行 append 一条 run + totals 重算——跨日成本聚合（MAPPING ❌ 列「成本聚合」的手写上岗，
// 补跑也是真金白银，按运行次记不按天记）。抽成导出函数：probe.ts 喂假数据零 token 验证落盘语义。
export interface RunHistory {
	totals: { runs: number; calls: number; promptTokens: number; completionTokens: number; elapsedMs: number }
	runs: Array<{ date: string; startedAt: string; elapsedMs: number; pass: boolean; topics: number; selected: number; calls: number; promptTokens: number; completionTokens: number }>
}
export async function writeOutputs(
	dir: string,
	data: {
		markdown: string
		results: TopicResult[]
		verdict: { pass: boolean; issues: string[]; score: number }
		ledger: Record<string, Ledger>
		startedAt: number
	}
): Promise<{ reportPath: string; totals: { calls: number; promptTokens: number; completionTokens: number }; elapsedMs: number }> {
	await fs.mkdir(dir, { recursive: true })
	const date = today()
	const elapsedMs = Date.now() - data.startedAt
	const reportPath = path.join(dir, `${date}.md`)
	await fs.writeFile(reportPath, data.markdown, 'utf8')

	const tot = Object.values(data.ledger).reduce(
		(a, l) => ({ calls: a.calls + l.calls, promptTokens: a.promptTokens + l.promptTokens, completionTokens: a.completionTokens + l.completionTokens }),
		{ calls: 0, promptTokens: 0, completionTokens: 0 }
	)
	const startedAt = new Date(data.startedAt).toISOString()
	// 当日快照：日报/状态同语义——一天一份最新（重跑覆盖当日，看当天最后一次）
	const status = {
		date,
		model: MODEL,
		startedAt,
		elapsedMs,
		verdict: data.verdict,
		topics: data.results.map((r) => ({
			id: r.topic.id,
			name: r.topic.name,
			raw: r.raw,
			selected: r.items.length,
			digest: r.digest,
			sourceErrors: r.errors,
		})),
		ledger: data.ledger,
		reportPath,
	}
	await fs.writeFile(path.join(dir, `status-${date}.json`), JSON.stringify(status, null, 2), 'utf8')

	// 跨日汇总：首跑无 history 用空台账起（只 catch ENOENT——文件存在但坏了就让它炸，别静默吞账本）
	const historyPath = path.join(dir, 'history.json')
	let history: RunHistory = { totals: { runs: 0, calls: 0, promptTokens: 0, completionTokens: 0, elapsedMs: 0 }, runs: [] }
	try {
		history = JSON.parse(await fs.readFile(historyPath, 'utf8'))
	} catch (err: any) {
		if (err?.code !== 'ENOENT') throw err
	}
	history.runs.push({
		date,
		startedAt,
		elapsedMs,
		pass: data.verdict.pass,
		topics: data.results.length,
		selected: data.results.reduce((n, r) => n + r.items.length, 0),
		calls: tot.calls,
		promptTokens: tot.promptTokens,
		completionTokens: tot.completionTokens,
	})
	history.totals = history.runs.reduce(
		(a, r) => ({ runs: a.runs + 1, calls: a.calls + r.calls, promptTokens: a.promptTokens + r.promptTokens, completionTokens: a.completionTokens + r.completionTokens, elapsedMs: a.elapsedMs + r.elapsedMs }),
		{ runs: 0, calls: 0, promptTokens: 0, completionTokens: 0, elapsedMs: 0 }
	)
	await fs.writeFile(historyPath, JSON.stringify(history, null, 2), 'utf8')
	return { reportPath, totals: tot, elapsedMs }
}

// ---------- main ----------
async function main() {
	const t0 = Date.now()
	const subs = JSON.parse(await fs.readFile(path.join(DIR, 'subscriptions.json'), 'utf8'))
	console.log(`[daily-brief] ${today()} · ${subs.topics.length} 个主题 · model=${MODEL}`)

	// fanout（10 的模式）：每主题一个 researcher 并行——抓源不串行等待
	const results = await Promise.all(subs.topics.map(researchTopic))
	const poolURLs = new Set(results.flatMap((r) => r.items.map((i: ResearcherItem) => i.url)))
	for (const r of results) {
		console.log(`[researcher:${r.topic.id}] 原始 ${r.raw} 条 → 精选 ${r.items.length} 条${r.errors.length ? ` · 源错误: ${r.errors.length}` : ''}`)
	}

	// writer → critic →（不过）重写一轮（08 自修一轮同款，烧钱上限明确）
	let markdown = await writeReport(results)
	let verdict = await critique(markdown, results, poolURLs)
	console.log(`[critic] pass=${verdict.pass}${verdict.issues.length ? ` issues: ${verdict.issues.join('；')}` : ''}`)
	if (!verdict.pass) {
		console.log('[writer] 按质检意见重写一轮')
		markdown = await writeReport(results, { issues: verdict.issues })
		verdict = await critique(markdown, results, poolURLs)
		console.log(`[critic·重审] pass=${verdict.pass}`)
	}

	// 落盘三件套：日报 md + status-日期.json + history.json 跨日汇总（writeOutputs）
	const { reportPath, totals: tot, elapsedMs } = await writeOutputs(REPORTS, { markdown, results, verdict, ledger, startedAt: t0 })

	// 总账（×N 账本；累计总账在 history.json.totals）
	console.log(`\n[落盘] ${reportPath}`)
	console.log(`[总账] 本次 ${tot.calls} 次调用 · ${tot.promptTokens}/${tot.completionTokens} tokens · 墙钟 ${(elapsedMs / 1000).toFixed(1)}s`)
	if (!verdict.pass) process.exitCode = 1
}

// isMain 守卫（spawn.ts 同款纪律）：pipeline 既是 cron 入口又是 probe 的 import 库——
// 没有这行，probe.ts 一 import 就把真产线跑一遍（2026-10-28 实录：探针「零 token」被
// import 副作用烧了一发 29k token + 覆盖当日真日报——「入口即库」的文件必须显式分家）
const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href
if (isMain) main()
