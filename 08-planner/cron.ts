/*
模块 08 §4：cron 定时唤醒 + 后台任务（骨架——核心逻辑你来填）

设计一句话：一个进程内的迷你 cron 守护——注册 job（cron 表达式 + 异步函数），
到点唤醒、后台执行、完成写通知。零依赖，Node 计时器就是调度器。

任务清单（①~④ 是学习核心，你来填；注册表/持久化/通知/入口我写好了）：
① parseCron     5 域表达式 → 允许值集合
② nextFire      下次触发时间（逐分钟步进）
③ runScheduler  调度循环（setTimeout 链，不是 setInterval）
④ catchUpMissed 错过的触发怎么办（补跑 or 跳过）

三个坑预告（踩实了记 PITFALLS）：
- 堆叠：setInterval 在「任务耗时 > 周期」时会 overlap（07「Promise.all 并发写互相覆盖」的兄弟坑）
  ——setTimeout 链每轮重算下一次，天然防堆叠
- unawaited 崩进程：fire 不 await（后台跑），job 的异常必须自己 .catch——07 #18 的教训
  「钩子必须自己消化错误」原样适用于定时任务
- 时区：教学版全用本地时间；生产/跨时区用 UTC 或交给 orchestrator——cron + 夏令时是经典雷区
  （本地时逐分钟步进跨 DST 会跳过/重复一小时，知道这个坑存在就够了）

用法：
  node 08-planner/cron.ts                     守护进程（调度循环，Ctrl+C 退）
  node 08-planner/cron.ts list                列出 job + 下次触发时间（验证 ①② 最快方式）
  node 08-planner/cron.ts run memory-sweep    立即手动触发一个 job（不等 cron）
  node 08-planner/cron.ts next '0 9 * * 1-5'  算任意表达式的下次触发（调试 parseCron/nextFire）

cron 开发第一律：别靠真等。手动 run 验证任务本身，list/next 验证时间计算，
调试表达式用 '* * * * *'（每分钟）——验证 5 分钟粒度以上的真表达式前，先用 next 干跑一遍
*/
import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import './agent.ts' // 只为注册副作用：merge 策略 + 工具表。不 import 它，dedupeMemories 的 LLM 合并会退化成字符串拼接
import { dedupeMemories } from './memory.ts'

// ---------- ① cron 表达式 ----------
// 5 域：分 时 日 月 周（周 0=周日）。支持子集：* | */n | n | a,b | a-b（可组合 '1-3,15'）
// 例：'*/30 8 * * *' 每天 8:00、8:30；'0 9 * * 1-5' 工作日 9 点；'0 4 * * *' 每天凌晨 4 点
export type CronFields = number[][] // 每域一组允许值：[分集合, 时集合, 日集合, 月集合, 周集合]

const FIELD_RANGES: [number, number][] = [
	[0, 59], // 分
	[0, 23], // 时
	[1, 31], // 日
	[1, 12], // 月
	[0, 6], // 周
]

// 解析哲学：配置错误要在注册时炸，别留到运行时静默不触发
// （金笔记：「永不触发的表达式」是最阴的配置错误：不报错、不跑、只让你等）
// [from, to] 闭区间序列，步长 step（'*' 和 'a-b' 传 1，'*/n' 传 n）
function seq(from: number, to: number, step = 1): number[] {
	const res: number[] = []
	for (let v = from; v <= to; v += step) res.push(v)
	return res
}

// token 级解析：单个 token（'*' | '*/n' | 'n' | 'a-b'）→ 允许值数组。
// 每个正则只 exec 一次、四种形态各自 return——互不共享代码，谁也抄不着谁的正则
function parseToken(token: string, min: number, max: number, pos: number): number[] {
	if (token === '*') {
		return seq(min, max)
	}
	const stepM = /^\*\/(\d+)$/.exec(token)
	if (stepM) {
		const n = Number(stepM[1])
		// 步长 0 → j += 0 死循环挂进程，必须在进循环前拦；步长超过跨度则没有第二个触发点，同算配置错误
		if (n < 1 || n > max - min) throw new Error(`第${pos}个域 ${token} 配置非法：步长要在 1~${max - min}`)
		return seq(min, max, n)
	}
	const rangeM = /^(\d+)-(\d+)$/.exec(token)
	if (rangeM) {
		const a = Number(rangeM[1])
		const b = Number(rangeM[2])
		if (a < min || a > max || b < min || b > max || a > b) throw new Error(`第${pos}个域 ${token} 配置非法：域范围 ${min}~${max}`)
		return seq(a, b)
	}
	const singleM = /^(\d+)$/.exec(token)
	if (singleM) {
		const v = Number(singleM[1])
		// 含端点：分 0（整点）、时 23、日 31、月 12 全是最常用的合法值——边界判断用严格 < 和 >
		if (v < min || v > max) throw new Error(`第${pos}个域 ${token} 配置非法：域范围 ${min}~${max}`)
		return [v] // 单值必须真的返回进去——空集合 = 该域永不命中 = 静默不触发
	}
	throw new Error(`第${pos}个域 ${token} 配置非法`)
}

export function parseCron(expr: string): CronFields {
	const fields = expr.trim().split(/\s+/)
	if (fields.length !== 5) {
		throw new Error('cron表达式必须是 5 域')
	}
	// 每域 = 逗号切开的 token 各自解析 → 取并集：'1-3,15' → {1,2,3} ∪ {15} → [1,2,3,15]。
	// Set 去重（'1-3,2' 这种重叠写法不炸、不重复）；排序纯给人看（list / debug 输出稳定）
	return fields.map((field, i) => {
		const [min, max] = FIELD_RANGES[i]
		const union = new Set<number>()
		for (const token of field.split(',')) {
			for (const v of parseToken(token, min, max, i + 1)) union.add(v)
		}
		return [...union].sort((a, b) => a - b)
	})
}

// ---------- ② 下次触发 ----------
// 从 from 的下一分钟起，逐分钟试探第一个「五域全命中」的时刻。
// 教学版故意暴力步进（最多扫 366 天）——正确且好懂；生产版是算术跳跃（每域找下一个允许值进位），
// O(域数) 但边界多。先对再快
export function nextFire(fields: CronFields, from = new Date()): Date {
	// 1. 游标 = from 秒/毫秒清零后 +1 分钟（当前这一分钟已过半也算过了——只看未来）
	// 2. 循环：getMinutes/getHours/... 五个值都在对应集合里 → 返回游标；否则游标 +1 分钟
	//    坑：别用 setMinutes(+1) 原地改再复用——跨月/DST 会让「+1分钟」实际跳 23h 或跳过 1h；
	//    每步 new Date(y, mo, d, h, mi + 1) 让 Date 构造器自己进位，永远真的只加一分钟
	// 3. 安全阀：超过 366*24*60 步 → throw（'0 0 31 2 *' 二月三十一日，永不触发的表达式）
	// 这个会修改入参 from。如果多次调用会出bug
	// from.setMilliseconds(0)
	// from.setSeconds(0)
	// from.setMinutes(from.getMinutes() + 1)
	let current = Math.floor(from.getTime() / 60000) + 1 // 截到分钟再 +1——纯算术，零变异，语义和你现在的完全一致
	const end = current + 366 * 24 * 60
	const [minutes, hours, days, months, weeks] = fields
	while (current <= end) {
		const time = new Date(current * 60 * 1000)
		const minute = time.getMinutes()
		const hour = time.getHours()
		const day = time.getDate()
		const month = time.getMonth() + 1
		const week = time.getDay()
		if (minutes.includes(minute) && hours.includes(hour) && days.includes(day) && months.includes(month) && weeks.includes(week)) {
			return time
		}
		current++
	}
	throw new Error(`${fields}，永不触发的表达式`)
}

// ---------- 任务注册 ----------
export interface Job {
	name: string
	expr: string // 原文留着给 list 展示
	fields: CronFields
	fn: () => Promise<string> // 返回报告文本，进通知
	catchUp: boolean // 错过的触发要不要补跑——见 ④ 的金笔记
	lastRun?: string // ISO 时间，持久化在 scheduler-state.json
}
const jobs = new Map<string, Job>()

export function registerJob(name: string, expr: string, fn: () => Promise<string>, opts?: { catchUp?: boolean }): void {
	const fields = parseCron(expr) // 解析炸在注册时（见 ① 金笔记）
	jobs.set(name, { name, expr, fields, fn, catchUp: opts?.catchUp ?? false })
}

// ---------- 持久化 + 通知（机械，写好了） ----------
const STATE_PATH = path.resolve(import.meta.dirname, 'scheduler-state.json')
async function readState(): Promise<Record<string, string>> {
	try {
		return JSON.parse(await fs.readFile(STATE_PATH, 'utf8'))
	} catch {
		return {}
	}
}
async function writeState(map: Record<string, string>): Promise<void> {
	await fs.writeFile(STATE_PATH, JSON.stringify(map, null, 2))
}

// 完成通知 = 控制台 + 审计日志追加（07 appendAudit 同款模式——'a' flag，日志天生该追加）
async function notify(title: string, body: string): Promise<void> {
	const line = `${new Date().toISOString()} ${title} ${body}`
	console.log(`[notify] ${line}`)
	const dir = path.resolve(import.meta.dirname, 'log')
	await fs.mkdir(dir, { recursive: true })
	await fs.writeFile(path.join(dir, 'job-audit.log'), line + '\n', { flag: 'a' })
}

// fire 一个 job：跑、计时、成败都通知、更新 lastRun——异常到不了调度器（见 runScheduler 金笔记②）
async function fire(job: Job): Promise<void> {
	const t0 = Date.now()
	try {
		const report = await job.fn()
		await notify(`✓ ${job.name}`, `(${((Date.now() - t0) / 1000).toFixed(1)}s) ${report.slice(0, 200)}`)
	} catch (err: any) {
		await notify(`✗ ${job.name}`, `(${((Date.now() - t0) / 1000).toFixed(1)}s) 失败: ${err?.message ?? err}`)
	} finally {
		job.lastRun = new Date().toISOString()
		const state = await readState()
		state[job.name] = job.lastRun
		await writeState(state)
	}
}

// ---------- ④ 错过的触发（你来定策略） ----------
// 「错过」主要指进程挂了：不运行的进程没有计时器，醒来时世界已经往前走了。
async function catchUpMissed(): Promise<void> {
	// 对每个 job：
	// 1. lastRun 存在且 nextFire(fields, new Date(lastRun)) < now → 中间至少错过一次触发
	// 2. catchUp=true → 补跑一次（封顶一次——挂机三天别跑成 72 次巡检，补「最新状态」不是补「历史」）
	//    catchUp=false → 只 notify 一行「跳过 N 次触发」
	// 金笔记：补跑策略由幂等性决定，所以 catchUp 是 job 级配置不是全局开关——
	//   dedupeMemories 跑十遍结果一样（幂等，可补）；「今天的日报」补昨天的没意义（跳过）
	for (const [name, job] of jobs.entries()) {
		const { fields, catchUp } = job
		let cursor = job.lastRun
		if (cursor && nextFire(fields, new Date(cursor)).getTime() < Date.now()) {
			if (catchUp) {
				await fire(job)
			} else {
				let count = 0
				while (nextFire(fields, new Date(cursor)).getTime() < Date.now()) {
					cursor = nextFire(fields, new Date(cursor)).toISOString()
					count++
				}
				// job中的lastRun需要更新为最近的一次时间,不然会越积越多
				job.lastRun = new Date(cursor).toISOString()
				const state = await readState()
				state[job.name] = job.lastRun
				await writeState(state)
				await notify(`任务漏跑通知`, `任务 ${name} 跳过了 ${count} 次触发`)
			}
		}
	}
}

// ---------- ③ 调度循环（你来填） ----------
export async function runScheduler(): Promise<void> {
	// 骨架：
	// 1. 恢复 state（readState → 回填各 job.lastRun）→ await catchUpMissed()
	// 2. while (true)：
	//    a. 对每个 job 算 nextFire，取最近的时刻
	//    b. await new Promise(r => setTimeout(r, 最近时刻 - now))  —— 睡到点
	//    c. 对到点的 job：void fire(job)（不 await！调度器立刻回去算下一轮）
	// 金笔记①：为什么 setTimeout 链不是 setInterval——interval 在任务耗时 > 周期时堆叠
	//   （同一 job 多个实例并发跑，07 写文件互踩的兄弟坑）；timeout 链每轮醒来重算，天然串行化
	// 金笔记②：void fire(...) 是又一个 unawaited 异步——fire 内部 try/catch/finally 全兜住了，
	//   异常出不来（07 #18：unhandled rejection 崩的是整个进程，不是一次任务）
	const state = await readState()
	for (const [name, lastRun] of Object.entries(state)) {
		const job = jobs.get(name)
		job && (job.lastRun = lastRun)
	}
	await catchUpMissed()
	while(true) {
		const map = new Map<number, Job[]>()
		const nextFires = [...jobs.values()].map((job) => {
			const { fields } = job
			const time = nextFire(fields).getTime()
			if (!map.get(time)) map.set(time, [])
			map.get(time)?.push(job)
			return time
		})
		if(!nextFires.length) break
		const recent = Math.min(...nextFires)
		await new Promise((resolve) => setTimeout(resolve, recent - Date.now()))
		map.get(recent)?.forEach(job => void fire(job))
	}
}

// ---------- 演示任务（接好了，跑起来就有真活干） ----------
// 记忆巡检：07 手动跑的 test_dedup clean → 08 的定时任务。去重 + 并集合并，幂等，可补跑
registerJob(
	'memory-sweep',
	'*/5 * * * *', // 开发期每 5 分钟；稳定后改 '0 4 * * *'（凌晨低峰）
	async () => {
		const merged = await dedupeMemories()
		return merged.length ? `合并 ${merged.length} 组重复记忆：${merged.join('、')}` : '无重复记忆，巡检通过'
	},
	{ catchUp: true },
)
// 每日简报（模板留位，想接再接——注意它每次触发都花 token，接了把 cron 改到早上）：
// registerJob('daily-brief', '30 8 * * *', async () => {
//   const ctx = await createAgent('用一段话总结我的记忆库：我现在生活里最重要的事是什么')
//   return agentLoop(ctx)
// })

// ---------- 入口 ----------
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
	const [cmd, arg] = process.argv.slice(2)
	if (cmd === 'list') {
		for (const job of jobs.values()) {
			console.log(`${job.name.padEnd(16)} '${job.expr}'  下次: ${nextFire(job.fields).toLocaleString()}  catchUp: ${job.catchUp}`)
		}
	} else if (cmd === 'next') {
		console.log(`'${arg}' 下次触发: ${nextFire(parseCron(arg!)).toLocaleString()}`)
	} else if (cmd === 'run' && jobs.has(arg!)) {
		console.log(`手动触发 ${arg}...`)
		await fire(jobs.get(arg)!)
	} else if (!cmd) {
		console.log(`调度器启动：${jobs.size} 个 job。Ctrl+C 退出`)
		await runScheduler()
	} else {
		console.log('用法: list | next "<expr>" | run <job名> | (无参数=启动调度器)')
	}
}
