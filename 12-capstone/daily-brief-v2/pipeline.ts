// 模块 12 毕业项目 v2：多租户产线——v1 的角色层（researcher/writer/critic）原样搬进 runUser 闭包，
// 外面包一层「逐用户循环 + 全局日预算熔断」。v1→v2 变化清单：
//   ① 订阅形状：hnQuery/githubQuery 两槽 → sources: [{type:'hn'|'github'|'arxiv'|'rss', query}] 自由组合
//   ② audience 字段（每人一句「我是谁」）：researcher 筛选标准 + writer 成稿口吻跟着读者变——
//      多用户下 v1「读者是在学 agent 开发的工程师」的硬编码假设不再成立
//   ③ 台账分家：per-user ledger（闭包内）+ 全局 budget-日期.json（跨用户累计，熔断依据）
//   ④ 通知：各自 profile.sendkey（用户在 H5 自助填），admin 额外收熔断报告
//   ⑤ chat/fetchSources 可注入：probe 假 LLM + 假抓取零 token 跑全链（P7~P8）
//
// 跑法：node 12-capstone/daily-brief-v2/pipeline.ts            # 全员（cron）
//       node 12-capstone/daily-brief-v2/pipeline.ts --user <uid> # 单人（server 补跑）
import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { client, MODEL } from '../../09-harness/llm.ts'
import { fetchTopicSources, type RawItem, type SourceSpec } from './sources.ts'
import { listUsers, type Profile } from './users.ts'
import { publicURL } from './lan.ts'

const DIR = import.meta.dirname
const DATA = process.env.V2_DATA_DIR ? path.resolve(process.env.V2_DATA_DIR) : path.join(DIR, 'data')
const userDir = (uid: string) => path.join(DATA, 'users', uid)
const reportsOf = (uid: string) => path.join(DATA, 'reports', uid)
const today = () => {
	const d = new Date()
	const p = (n: number) => String(n).padStart(2, '0')
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
async function readJSON<T>(file: string, fallback: T): Promise<T> {
	try {
		return JSON.parse(await fs.readFile(file, 'utf8')) as T
	} catch (err: any) {
		if (err?.code !== 'ENOENT') throw err
		return fallback
	}
}

// ---------- LLM 单发调用（v1 原样） ----------
interface ChatResult { text: string; promptTokens: number; completionTokens: number; elapsedMs: number }
async function chat(
	system: string,
	user: string,
	opts?: { temperature?: number; thinking?: boolean }
): Promise<ChatResult> {
	const t0 = Date.now()
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
type ChatFn = typeof chat
type FetchFn = (specs: SourceSpec[]) => Promise<{ items: RawItem[]; errors: string[] }>

// 花括号切片（08）：剥 LLM 输出的 JSON，围栏/寒暄/尾随句全免疫
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

// ---------- 全局日预算（跨用户熔断依据：budget-日期.json） ----------
// 语义（DESIGN.md）：熔断在用户边界——runUser 开头检查；跑满一人的钱已经花了就让它跑完（半途而废更浪费），
// 下一个用户 skip（落 status 标记，不发假日报），次日文件名分家自然重置。
export interface Budget { date: string; calls: number; promptTokens: number; completionTokens: number }
let budgetQueue: Promise<unknown> = Promise.resolve()
const budgetFile = () => path.join(DATA, `budget-${today()}.json`)
async function loadBudget(): Promise<Budget> {
	// 每次读文件不缓存：产线单进程每天几个调用，省一次读不值得引入测试态（probe 可直接删文件重置）
	return readJSON<Budget>(budgetFile(), { date: today(), calls: 0, promptTokens: 0, completionTokens: 0 })
}
export async function budgetExceeded(): Promise<boolean> {
	const b = await loadBudget()
	const limitCalls = Number(process.env.DAILY_BUDGET_CALLS || 200)
	const limitTokens = Number(process.env.DAILY_BUDGET_TOKENS || 500000)
	return b.calls >= limitCalls || b.promptTokens + b.completionTokens >= limitTokens
}
async function budgetCharge(r: ChatResult): Promise<void> {
	// 串行队列：主题 fanout 并发记账防读改写竞态（emitProgress 同款）
	const run = async () => {
		const b = await loadBudget()
		b.calls++
		b.promptTokens += r.promptTokens
		b.completionTokens += r.completionTokens
		await fs.mkdir(DATA, { recursive: true })
		await fs.writeFile(budgetFile(), JSON.stringify(b, null, 2), 'utf8')
	}
	budgetQueue = budgetQueue.then(run, run)
	await budgetQueue
}

// ---------- 订阅与角色层 ----------
export interface Topic { id: string; name: string; focus: string; sources: SourceSpec[] }
export interface Subscriptions { audience: string; topics: Topic[] }

const ResearcherOut = z.object({
	items: z
		.array(z.object({ title: z.string(), title_zh: z.string(), comment: z.string(), url: z.string() }))
		.min(1),
	digest: z.string(),
})
type ResearcherItem = z.infer<typeof ResearcherOut>['items'][number]

export interface TopicResult {
	topic: Topic
	items: ResearcherItem[]
	digest: string
	raw: number
	errors: string[]
}
export interface Ledger { calls: number; promptTokens: number; completionTokens: number; elapsedMs: number }

// ---------- 落盘三件套（v1 原样搬：同日覆盖当日份 + history 跨日总账；dir 参数化天然按人分目录） ----------
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
		skipped?: string
	}
): Promise<{ reportPath: string; totals: { calls: number; promptTokens: number; completionTokens: number }; elapsedMs: number }> {
	await fs.mkdir(dir, { recursive: true })
	const date = today()
	const elapsedMs = Date.now() - data.startedAt
	// skipped 语义：无日报可写（预算熔断/无订阅），只落 status 供前端如实展示——绝不发假日报
	if (data.skipped) {
		await fs.writeFile(
			path.join(dir, `status-${date}.json`),
			JSON.stringify({ date, skipped: data.skipped, startedAt: new Date(data.startedAt).toISOString(), elapsedMs }, null, 2),
			'utf8'
		)
		return { reportPath: '', totals: { calls: 0, promptTokens: 0, completionTokens: 0 }, elapsedMs }
	}
	const reportPath = path.join(dir, `${date}.md`)
	await fs.writeFile(reportPath, data.markdown, 'utf8')
	const tot = Object.values(data.ledger).reduce(
		(a, l) => ({ calls: a.calls + l.calls, promptTokens: a.promptTokens + l.promptTokens, completionTokens: a.completionTokens + l.completionTokens }),
		{ calls: 0, promptTokens: 0, completionTokens: 0 }
	)
	const startedAt = new Date(data.startedAt).toISOString()
	await fs.writeFile(
		path.join(dir, `status-${date}.json`),
		JSON.stringify({
			date,
			model: MODEL,
			startedAt,
			elapsedMs,
			verdict: data.verdict,
			topics: data.results.map((r) => ({ id: r.topic.id, name: r.topic.name, raw: r.raw, selected: r.items.length, digest: r.digest, sourceErrors: r.errors })),
			ledger: data.ledger,
			reportPath,
		}, null, 2),
		'utf8'
	)
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

// ---------- 进度事件（v1 原样：串行队列防 fanout 并发写竞态；progress-日期.json 即 SSE 事件总线） ----------
export interface ProgressEvent { ts: string; stage: string; message: string }
let progressQueue: Promise<void> = Promise.resolve()
export function emitProgress(dir: string, stage: string, message: string): Promise<void> {
	const run = async () => {
		// mkdir 不可省：v1 靠「reports/ 已存在」苟着（§6 首跑建过），v2 每用户目录首写必 ENOENT——
		// 潜伏 bug 被多租户逼现身（2026-10-28 探针实录），目录创建放这里而不是指望调用方
		await fs.mkdir(dir, { recursive: true })
		const file = path.join(dir, `progress-${today()}.json`)
		let events: ProgressEvent[] = []
		try {
			events = JSON.parse(await fs.readFile(file, 'utf8'))
		} catch (err: any) {
			if (err?.code !== 'ENOENT') throw err
		}
		events.push({ ts: new Date().toISOString(), stage, message })
		await fs.writeFile(file, JSON.stringify(events, null, 2), 'utf8')
	}
	progressQueue = progressQueue.then(run, run)
	return progressQueue
}

// ---------- 通知（v1 sendToOne 原样；key 来源从 env 变 profile——每人自己的 sendkey） ----------
const maskKey = (k: string) => (k.length > 6 ? `${k.slice(0, 6)}…` : k)
async function sendToOne(key: string, title: string, desp: string): Promise<{ sent: boolean; reason?: string }> {
	try {
		const res = await fetch(`https://sctapi.ftqq.com/${key}.send`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ title, desp }),
			signal: AbortSignal.timeout(10_000),
		})
		const j: any = await res.json().catch(() => ({}))
		return j?.code === 0 ? { sent: true } : { sent: false, reason: `HTTP ${res.status}：${j?.message ?? '未知响应'}` }
	} catch (err: any) {
		return { sent: false, reason: err?.message } // 通知失败不碰 exitCode
	}
}
async function notifyUser(sendkey: string | undefined, title: string, desp: string): Promise<string> {
	if (!sendkey) return '未配置推送 key（no-op）'
	const r = await sendToOne(sendkey, title, desp)
	return r.sent ? '已推送' : `推送失败：${maskKey(sendkey)}（${r.reason ?? '未知'}）`
}

// ---------- 单用户产线（v1 main 的全部，闭包化：per-user ledger / audience 注入 / 记账统一入口） ----------
export async function runUser(
	user: Profile,
	opts: { chat?: ChatFn; fetchSources?: FetchFn } = {}
): Promise<{ ok: boolean; skipped?: string }> {
	const chatFn = opts.chat ?? chat
	const fetchSrc = opts.fetchSources ?? fetchTopicSources
	const REPORTS = reportsOf(user.id)
	const t0 = Date.now()

	// 订阅 + 读者身份（audience 容错合并：手写/旧文件没这字段也不许让 prompt 里出现 undefined）
	const subs = await readJSON<Partial<Subscriptions>>(path.join(userDir(user.id), 'subscriptions.json'), {})
	const audience = subs.audience || '关注科技动态的读者'
	const topics = subs.topics ?? []
	// 同日重跑=新流（挪到 skip 判定前：无订阅/熔断这些 skip 分支也该是新流——
	// 留着旧文件的话「重跑」会把上一轮的旧事件原样回放给 SSE 客户端，用户实录的重跑 bug）
	await fs.rm(path.join(REPORTS, `progress-${today()}.json`), { force: true })
	if (topics.length === 0) {
		await writeOutputs(REPORTS, { markdown: '', results: [], verdict: { pass: false, issues: [], score: -1 }, ledger: {}, startedAt: t0, skipped: '无订阅主题' })
		await emitProgress(REPORTS, 'skip', `${user.username}：无订阅主题，跳过（不烧钱）`)
		return { ok: true, skipped: '无订阅主题' }
	}

	await emitProgress(REPORTS, 'start', `${user.username} 的产线启动：${topics.length} 个主题 · ${MODEL}`)

	// 记账统一入口：所有角色调用走 doChat——per-user ledger + 全局 budget 两处同时记，不可能漏
	const ledger: Record<string, Ledger> = {}
	const doChat = async (stage: string, system: string, prompt: string, o?: { temperature?: number; thinking?: boolean }) => {
		const r = await chatFn(system, prompt, o)
		const l = (ledger[stage] ??= { calls: 0, promptTokens: 0, completionTokens: 0, elapsedMs: 0 })
		l.calls++
		l.promptTokens += r.promptTokens
		l.completionTokens += r.completionTokens
		l.elapsedMs += r.elapsedMs
		await budgetCharge(r)
		return r
	}

	// ----- researcher：抓源（sources 数组）→ LLM 筛选（zod 自修一轮 + URL⊆原始池程序断言，v1 原样） -----
	async function researchTopicInner(topic: Topic): Promise<TopicResult> {
		const { items, errors } = await fetchSrc(topic.sources)
		if (items.length === 0) return { topic, items: [], digest: '', raw: 0, errors }
		const pool = items.slice(0, 25) // 06 输入侧筛选：top25 进 prompt，上下文预算是钱
		const listing = pool.map((it, i) => `${i + 1}. ${it.title}\n   ${it.meta}\n   ${it.url}`).join('\n')
		const system = `你是情报研究员，为一位「${audience}」筛选每日情报。只从给定清单里选，绝不编造清单外的条目。`
		const user = `主题：【${topic.name}】（${topic.focus}）
过去两天该主题的候选条目：
${listing}

任务：选出 4~8 条对该读者最有价值的条目。噪声（营销稿、重复、纯吐槽）剔除。
每条给：英文原标题原样保留、中文翻译标题、中文点评（一两句：这条讲了什么、为什么值得看）。
最后给本主题今日一句话总评。
只输出 JSON：{"items":[{"title":"","title_zh":"","comment":"","url":""}],"digest":""}`
		let parsed: z.infer<typeof ResearcherOut> | null = null
		let lastRaw = ''
		for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
			const r = await doChat(`researcher:${topic.id}`, system, attempt === 0 ? user : `${user}\n\n上一次输出不是合法 JSON 或字段缺失：${lastRaw.slice(0, 200)}。重新输出完整 JSON。`, { temperature: 0.3, thinking: false })
			const raw = sliceJSON(r.text)
			if (!raw) { lastRaw = r.text; continue }
			const check = ResearcherOut.safeParse(JSON.parse(raw))
			if (check.success) parsed = check.data
			else lastRaw = JSON.stringify(check.error.issues.slice(0, 3))
		}
		if (!parsed) return { topic, items: [], digest: `（researcher 两轮都没给出合法 JSON——主题降级空板块）`, raw: pool.length, errors }
		const poolURLs = new Set(pool.map((p) => p.url))
		return { topic, items: parsed.items.filter((it) => poolURLs.has(it.url)), digest: parsed.digest, raw: pool.length, errors }
	}
	async function researchTopic(topic: Topic): Promise<TopicResult> {
		try {
			return await researchTopicInner(topic)
		} catch (err: any) {
			// 单主题崩 ≠ 全链崩（spawn.ts 失败传播三入口教训——fetch 降级了 researcher 也要降级）
			return { topic, items: [], digest: `（researcher 异常降级：${String(err?.message).slice(0, 120)}）`, raw: 0, errors: [String(err?.message)] }
		}
	}

	// ----- writer / critic（v1 原样，audience 替换硬编码读者） -----
	async function writeReport(
		sections: { topic: { id: string; name: string }; items: ResearcherItem[]; digest: string }[],
		revision?: { issues: string[] }
	): Promise<string> {
		const material = sections
			.map((s) => `## ${s.topic.name}\n总评：${s.digest}\n条目：\n${s.items.map((it) => `- ${it.title} | 译：${it.title_zh} | 点评：${it.comment} | ${it.url}`).join('\n')}`)
			.join('\n\n')
		const system = `你是日报主编。输入是研究员按主题整理好的条目材料，你把它编成一份清爽的中文 markdown 日报。英文条目标题用「中文译名（英文原名）」并列呈现，保留全部链接。不编造材料外的事实和链接。`
		const user = `今天是 ${today()}。材料：
${material}

要求：
1. 一级标题「情报日报 ${today()}」
2. 每个主题一个二级标题节，节首放该主题总评，条目用列表（链接放条目行内）
3. 末尾「今日总评」一段：跨主题串一遍今天最重要的 2~3 件事
4. 全文中文（条目英文原名除外），读者是「${audience}」
${revision ? `\n上一版被质检打回，问题：${revision.issues.join('；')}。这次针对性修正。` : ''}`
		const r = await doChat('writer', system, user, { temperature: 0.5, thinking: true })
		return r.text
	}
	async function critique(
		markdown: string,
		sections: { topic: { id: string; name: string }; items: ResearcherItem[] }[],
		poolURLs: Set<string>
	): Promise<{ pass: boolean; issues: string[]; score: number }> {
		const issues: string[] = []
		for (const s of sections) if (s.items.length > 0 && !markdown.includes(s.topic.name)) issues.push(`缺「${s.topic.name}」节`)
		const urlsInReport = [...markdown.matchAll(/https?:\/\/[^\s)>\]]+/g)].map((m) => m[0].replace(/[.,;]$/, ''))
		const fabricated = urlsInReport.filter((u) => !poolURLs.has(u))
		if (fabricated.length) issues.push(`出现原始池外的链接：${fabricated.slice(0, 3).join(' , ')}`)
		if (markdown.length < 500) issues.push(`正文过短（${markdown.length} 字）`)
		if (issues.length === 0) {
			const r = await doChat('critic', `你是日报质检员。给这份日报打分（1~10）并给出改进意见。低于 7 分或有事实性问题判不过。只输出 JSON：{"score":0,"issues":[""],"pass":true}`, markdown, { temperature: 0.1, thinking: false })
			const raw = sliceJSON(r.text)
			if (raw) {
				const v = JSON.parse(raw)
				if (!v.pass || v.score < 7) issues.push(...(v.issues ?? [`质检分 ${v.score}`]))
			}
		}
		return { pass: issues.length === 0, issues, score: -1 }
	}

	// ----- 主流程：fanout → writer → critic →（打回重写一轮）→ 落盘 → 通知（v1 原样） -----
	const results = await Promise.all(
		topics.map(async (t) => {
			const r = await researchTopic(t)
			await emitProgress(REPORTS, 'researcher', `${r.topic.name}：原始 ${r.raw} 条 → 精选 ${r.items.length} 条${r.errors.length ? `（源错误 ${r.errors.length} 个）` : ''}`)
			return r
		})
	)
	const poolURLs = new Set(results.flatMap((r) => r.items.map((i) => i.url)))
	await emitProgress(REPORTS, 'writer', `写手成稿中（${results.reduce((n, r) => n + r.items.length, 0)} 条素材）`)
	let markdown = await writeReport(results)
	let verdict = await critique(markdown, results, poolURLs)
	await emitProgress(REPORTS, 'critic', `一审 ${verdict.pass ? '过审' : '打回'}${verdict.issues.length ? `：${verdict.issues[0].slice(0, 80)}` : ''}`)
	if (!verdict.pass) {
		await emitProgress(REPORTS, 'writer', '按质检意见重写一轮')
		markdown = await writeReport(results, { issues: verdict.issues })
		verdict = await critique(markdown, results, poolURLs)
		await emitProgress(REPORTS, 'critic', `重审 ${verdict.pass ? '过审' : '仍未过（按现状落盘，如实记台账）'}`)
	}
	const { reportPath, totals: tot, elapsedMs } = await writeOutputs(REPORTS, { markdown, results, verdict, ledger, startedAt: t0 })
	await emitProgress(REPORTS, 'done', `落盘完成 · ${tot.calls} 调用 · ${tot.promptTokens}/${tot.completionTokens} tokens · ${(elapsedMs / 1000).toFixed(0)}s · ${verdict.pass ? '过审' : '未过审'}`)

	// 通知：标题进卡片，desp 放总评 + 链接（自动探测 IP 漂移跟随 / V2_PUBLIC_URL 钉死逃生门）
	const summary = markdown.includes('## 今日总评') ? markdown.split('## 今日总评')[1].trim().slice(0, 500) : markdown.slice(0, 500)
	const url = publicURL()
	const note = await notifyUser(
		user.sendkey,
		`情报日报 ${today()}${verdict.pass ? '已生成' : '已生成（质检未过审）'}`,
		url ? `${summary}\n\n---\n\n[打开日报](${url})` : `${summary}\n\n（未探测到服务地址——请在服务器本机查看）`
	)
	console.log(`[${user.username}] 日报 ${reportPath ? '落盘' : '未落盘'} · ${tot.calls} 调用 · 通知 ${note}`)
	await emitProgress(REPORTS, 'notify', note)
	return { ok: verdict.pass }
}

// ---------- 多租户主循环：预算熔断在用户边界 + 熔断报告给 admin ----------
export async function runPipeline(
	users: Profile[],
	opts: { chat?: ChatFn; fetchSources?: FetchFn } = {}
): Promise<{ done: string[]; skipped: { username: string; reason: string }[]; failed: string[] }> {
	const done: string[] = []
	const skipped: { username: string; reason: string }[] = []
	const failed: string[] = []
	for (const user of users) {
		if (await budgetExceeded()) {
			const reason = '全局日预算已熔断'
			await fs.rm(path.join(reportsOf(user.id), `progress-${today()}.json`), { force: true }) // 同日重跑=新流（skip 分支同款）
			await writeOutputs(reportsOf(user.id), { markdown: '', results: [], verdict: { pass: false, issues: [], score: -1 }, ledger: {}, startedAt: Date.now(), skipped: reason })
			await emitProgress(reportsOf(user.id), 'skip', `${user.username}：${reason}，今日不发（明日自动恢复）`)
			console.log(`[${user.username}] skip：${reason}`)
			skipped.push({ username: user.username, reason })
			continue
		}
		try {
			const r = await runUser(user, opts)
			r.skipped ? skipped.push({ username: user.username, reason: r.skipped }) : done.push(user.username)
		} catch (err: any) {
			// 单用户崩 ≠ 全员崩（逐用户 try/catch——researcher 已降级到主题级，这里是用户级）
			await emitProgress(reportsOf(user.id), 'error', `产线未捕获异常：${String(err?.message).slice(0, 150)}`).catch(() => {})
			console.error(`[${user.username}] 崩溃：`, err?.message)
			failed.push(user.username)
		}
	}
	// 熔断/失败要让运营者知道：admin 收一条汇总（admin 没配 sendkey 就是 no-op——纪律同上）
	const admin = users.find((u) => u.admin) ?? (await listUsers()).find((u) => u.admin)
	if (admin && (skipped.length > 0 || failed.length > 0)) {
		const note = await notifyUser(
			admin.sendkey,
			`daily-brief 运维告警 ${today()}`,
			`跳过：${skipped.map((s) => `${s.username}（${s.reason}）`).join('、') || '无'}\n失败：${failed.join('、') || '无'}`
		)
		console.log(`[运维告警→admin] ${note}`)
	}
	return { done, skipped, failed }
}

// ---------- main（cron 入口；--user uid 单人补跑给 server 用） ----------
async function main() {
	const users = await listUsers()
	if (users.length === 0) {
		console.log('[daily-brief-v2] 零用户——先跑 server 注册（首码见启动日志），再注册用户')
		return
	}
	const target = process.argv[2] === '--user' ? users.filter((u) => u.id === process.argv[3]) : users
	if (target.length === 0) {
		console.log(`[daily-brief-v2] 没有匹配的用户：${process.argv[3]}`)
		process.exitCode = 1
		return
	}
	console.log(`[daily-brief-v2] ${today()} · ${target.length} 个用户 · model=${MODEL}`)
	const r = await runPipeline(target)
	console.log(`\n[总账] 完成 ${r.done.length} · 跳过 ${r.skipped.length} · 失败 ${r.failed.length}`)
	if (r.failed.length > 0) process.exitCode = 1
}

// isMain 守卫（v1 事故实录：入口即库必须分家——probe import 不许跑真产线）
const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href
if (isMain) main()
