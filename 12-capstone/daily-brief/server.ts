// 模块 12 §7：daily-brief 读报服务——零依赖原生 http（09「能不用框架就不用」路线）
//
// 端点一览（uniapp H5 / 浏览器 / curl 都吃这套）：
//   GET  /api/latest          最新日报全家桶：{date, markdown, status, progress, running}
//   GET  /api/report?date=    指定日期日报（缺 date = 最新）
//   GET  /api/history         跨日台账（history.json 原样）
//   GET  /api/topics          订阅清单 / POST /api/topics 整体替换（uniapp 订阅管理页用）
//   GET  /api/progress?date=  进度事件数组——App 端 SSE 不通时的轮询降级通道
//   GET  /api/events          SSE 进度流（fs.watch progress 文件，连接时全量回放 + 增量推送）
//   POST /api/run             补跑：spawn 产线子进程（cron 之外的手动触发；已在跑 409）
//   GET  /                    静态：uniapp 构建产物（app/dist）优先，没有则内置占位读报页
//
// 设计对照：
//   progress 文件即事件总线 = 11 TraceCollector 的落盘思想——产线（cron 或 spawn）与 server 两个进程
//     解耦，谁起的产线 server 都能 watch 到（不是只有 server spawn 的才可见）
//   fs.watch + 按事件数 diff = 增量广播（读全文件、发新增段——progress 单日最多几十条，全量读没负担）
//   CORS * = 家庭局域网内 H5 dev(5173)→server(8787) 跨域，不值当搞白名单
// 跑法：node 12-capstone/daily-brief/server.ts（常驻；跑法/cron 见 register-task.ps1）
import 'dotenv/config'
import http from 'node:http'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { z } from 'zod'
import { lanIPv4 } from './lan.ts'

const DIR = import.meta.dirname
const REPORTS = path.join(DIR, 'reports')
const REPO_ROOT = path.resolve(DIR, '../../..')
const PORT = Number(process.env.BRIEF_PORT || 8787)

// ---------- 工具 ----------
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' }
const json = (res: http.ServerResponse, code: number, data: unknown) => {
	res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...CORS })
	res.end(JSON.stringify(data))
}
const readJSON = async <T>(file: string): Promise<T | null> => {
	try {
		return JSON.parse(await fs.readFile(file, 'utf8')) as T
	} catch (err: any) {
		if (err?.code !== 'ENOENT') throw err
		return null
	}
}
const datesOnDisk = async (): Promise<string[]> =>
	(await fs.readdir(REPORTS).catch(() => []))
		.map((f) => /^(\d{4}-\d{2}-\d{2})\.md$/.exec(f)?.[1])
		.filter((d): d is string => !!d)
		.sort()
const today = () => {
	const d = new Date()
	const p = (n: number) => String(n).padStart(2, '0')
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// ---------- 补跑（spawn 产线子进程；cron 与它是同一个入口文件） ----------
let running = false
function triggerRun(): { code: number; data: unknown } {
	if (running) return { code: 409, data: { running: true, message: '产线已在跑，等它落盘' } }
	running = true
	// cwd 必须是仓库根：dotenv 从 cwd 读 .env（任务计划/服务启动的 cwd 都不可靠，这里显式钉死）。
	// stdio 管道转发到 server 日志：2026-10-28 实录 stdio:'ignore' 吞了产线崩溃现场——
	// progress 停在第 4 条事件、exit 1、什么都看不到，排查全靠猜
	const child = spawn(process.execPath, [path.join(DIR, 'pipeline.ts')], { cwd: REPO_ROOT, env: process.env })
	child.stdout?.on('data', (d) => console.log(`[pipeline] ${String(d).trim()}`))
	child.stderr?.on('data', (d) => console.error(`[pipeline:err] ${String(d).trim()}`))
	child.on('error', (err) => {
		running = false
		console.error(`[run] spawn 失败：`, err?.message)
	})
	child.on('exit', (code) => {
		running = false
		console.log(`[run] 产线子进程退出 code=${code}`)
	})
	console.log(`[run] 补跑已触发 pid=${child.pid}`)
	return { code: 202, data: { started: true, pid: child.pid } }
}

// ---------- SSE：progress 文件即总线，watch 到变化就 diff 广播 ----------
const sseClients = new Set<http.ServerResponse>()
function broadcastProgress() {
	// 逐客户端按各自已发数 diff——连接有先后，全量回放只该发生在自己连接时
	for (const res of sseClients) {
		const sent = sentCounts.get(res) ?? 0
		const events = progressCache
		if (events.length > sent) {
			for (const ev of events.slice(sent)) res.write(`data: ${JSON.stringify(ev)}\n\n`)
			sentCounts.set(res, events.length)
		}
	}
}
let progressCache: unknown[] = []
const sentCounts = new Map<http.ServerResponse, number>()
async function refreshProgress(date: string) {
	progressCache = (await readJSON<unknown[]>(path.join(REPORTS, `progress-${date}.json`))) ?? []
	broadcastProgress()
}
fsSync.watch(REPORTS, { persistent: false }, (_ev, file) => {
	// 进度文件变化 → 重读广播；日报落盘 → 顺手刷新（最新日期可能变了）
	if (file?.startsWith('progress-')) refreshProgress(file.replace(/^progress-/, '').replace(/\.json$/, ''))
})

// ---------- 请求体读取 ----------
async function readBody(req: http.IncomingMessage): Promise<string> {
	let body = ''
	for await (const chunk of req) body += chunk
	return body
}

// ---------- 路由 ----------
const TopicSchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	focus: z.string(),
	hnQuery: z.string().min(1),
	githubQuery: z.string().min(1),
})

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
	const route = `${req.method} ${url.pathname}`
	try {
		// CORS 预检
		if (req.method === 'OPTIONS') {
			res.writeHead(204, CORS)
			return res.end()
		}

		// ---- 日报 ----
		if (req.method === 'GET' && (url.pathname === '/api/latest' || url.pathname === '/api/report')) {
			const dates = await datesOnDisk()
			if (dates.length === 0) return json(res, 404, { error: '还没有任何日报（先跑一发：POST /api/run）' })
			const date = url.searchParams.get('date') ?? dates[dates.length - 1]
			const markdown = await fs.readFile(path.join(REPORTS, `${date}.md`), 'utf8').catch(() => null)
			if (markdown === null) return json(res, 404, { error: `${date} 没有日报`, available: dates })
			const status = await readJSON(path.join(REPORTS, `status-${date}.json`))
			const progress = (await readJSON(path.join(REPORTS, `progress-${date}.json`))) ?? []
			return json(res, 200, { date, markdown, status, progress, running, available: dates })
		}

		// ---- 台账 ----
		if (req.method === 'GET' && url.pathname === '/api/history') {
			const history = await readJSON(path.join(REPORTS, 'history.json'))
			return history ? json(res, 200, history) : json(res, 404, { error: '还没有台账' })
		}

		// ---- 订阅清单（07 记忆的增删改入口） ----
		if (url.pathname === '/api/topics') {
			if (req.method === 'GET') return json(res, 200, await readJSON(path.join(DIR, 'subscriptions.json')))
			if (req.method === 'POST') {
				const body = JSON.parse(await readBody(req))
				const parsed = z.object({ topics: z.array(TopicSchema).min(1) }).safeParse(body)
				if (!parsed.success) return json(res, 400, { error: '订阅清单格式不对', issues: parsed.error.issues.slice(0, 3) })
				// 保留 _comment 说明行——整体替换不丢订阅文件的使用说明
				const original = (await readJSON<any>(path.join(DIR, 'subscriptions.json'))) ?? {}
				await fs.writeFile(path.join(DIR, 'subscriptions.json'), JSON.stringify({ _comment: original._comment ?? '', topics: parsed.data.topics }, null, '\t'), 'utf8')
				console.log(`[topics] 订阅清单已更新：${parsed.data.topics.map((t) => t.id).join(', ')}`)
				return json(res, 200, { saved: parsed.data.topics.length })
			}
		}

		// ---- 进度（轮询降级通道：App 端 SSE 不通时 2s 一拉） ----
		if (req.method === 'GET' && url.pathname === '/api/progress') {
			const date = url.searchParams.get('date') ?? today()
			const events = (await readJSON(path.join(REPORTS, `progress-${date}.json`))) ?? []
			return json(res, 200, { date, events, running })
		}

		// ---- SSE ----
		if (req.method === 'GET' && url.pathname === '/api/events') {
			res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', ...CORS })
			res.write(`data: ${JSON.stringify({ ts: new Date().toISOString(), stage: 'connected', message: 'SSE 已连接（18s 心跳）' })}\n\n`)
			sseClients.add(res)
			sentCounts.set(res, 0)
			broadcastProgress() // 连接即回放已发生的事件（中途连上也能看全程）
			const hb = setInterval(() => res.write(': heartbeat\n\n'), 18_000) // 注释行心跳：防中间层掐空闲连接
			req.on('close', () => {
				clearInterval(hb)
				sseClients.delete(res)
				sentCounts.delete(res)
			})
			return // 连接保持打开，不 end
		}

		// ---- 补跑 ----
		if (req.method === 'POST' && url.pathname === '/api/run') {
			const r = triggerRun()
			return json(res, r.code, r.data)
		}

		// ---- 静态：uniapp 构建产物优先（uni 插件强制约定路径 dist/build/h5），没有给内置占位页 ----
		if (req.method === 'GET' && (url.pathname === '/' || url.pathname.startsWith('/assets/') || url.pathname.startsWith('/static/'))) {
			const dist = path.join(DIR, 'app', 'dist', 'build', 'h5')
			const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
			const content = await fs.readFile(path.join(dist, file)).catch(() => null)
			if (content !== null && file !== 'index.html') {
				const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream'
				res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, ...CORS })
				return res.end(content)
			}
			if (content !== null) {
				res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...CORS })
				return res.end(content)
			}
			// 占位页：等 uniapp 端（§7 下一步）——现在浏览器直开就有得看，不黑屏
			res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...CORS })
			return res.end(`<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI 情报日报</title><style>body{font-family:system-ui;max-width:820px;margin:0 auto;padding:16px;line-height:1.6}pre{white-space:pre-wrap;word-break:break-word;background:#f6f8fa;padding:12px;border-radius:8px}button{padding:8px 16px}</style></head><body><h3>AI 情报日报（占位页——uniapp 端构建后此处自动切换）</h3><button onclick="fetch('/api/run',{method:'POST'}).then(()=>location.reload())">补跑今日</button><pre id="r">加载中…</pre><script>fetch('/api/latest').then(r=>r.json()).then(d=>{document.getElementById('r').textContent=d.markdown;document.title='AI 情报日报 '+d.date}).catch(e=>document.getElementById('r').textContent='加载失败：'+e)</script></body></html>`)
		}

		json(res, 404, { error: `没这个路由：${route}`, hint: 'GET /api/latest | /api/history | /api/topics | /api/progress | /api/events · POST /api/run | /api/topics' })
	} catch (err: any) {
		console.error(`[server] ${route} 炸了：`, err?.message)
		json(res, 500, { error: err?.message })
	}
})

server.listen(PORT, async () => {
	// 局域网地址打印：手机连同一 WiFi 访问这个地址（Server酱通知链接发的就是它——发送时刻自动探测，IP 漂移跟随）
	const lan = lanIPv4()
	await refreshProgress(today())
	console.log(`[daily-brief server] http://localhost:${PORT} · 局域网: ${lan ? `http://${lan}:${PORT}` : '（未找到 192.168 网段——检查 WiFi）'}`)
	console.log(`[daily-brief server] 补跑=POST /api/run · 进度流=GET /api/events · cron 注册见 register-task.ps1`)
	// 手机打不开局域网地址——诊断三件套按序查（2026-10-28 实录：只看 NetworkCategory=Public 就断言
	// 防火墙拦截是误诊——实机 Get-NetFirewallProfile 显示 Private/Public 全 Disabled，真凶是热点 AP 隔离）：
	//   ① Get-NetFirewallProfile：防火墙真开着吗（Enabled=False 时网络类别/放行规则全无意义——先验「实际在拦」再谈「默认应该拦」）
	//   ② 开着 → Get-NetConnectionProfile 看类别；管理员放行端口（收敛原则：端口+RFC1918 私网段，不给程序全放行）：
	//      New-NetFirewallRule -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8787
	//        -RemoteAddress 10.0.0.0/8,172.16.0.0/12,192.168.0.0/16
	//   ③ 防火墙关着还打不开 → 热点/路由器 AP 隔离（设备间互访被禁，2026-10-28 小米WiFi 实锤），换个热点验证
	if (lan) console.log(`[daily-brief server] 手机打不开？按序查：①防火墙启用状态 ②端口放行 ③热点 AP 隔离（三件套见源码注释）`)
})
