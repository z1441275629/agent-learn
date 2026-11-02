// 模块 12 毕业项目 v2：读报服务——多用户 API（session 鉴权 / 用户隔离 / rate limit / SSE / 补跑）
//
// 与 v1 server 的差别（DESIGN.md §4）：
//   ① 每个数据端点按 session 用户取自己的目录（reports/<uid>/）——没有「全局日报」了
//   ② auth 三件（register/login/logout）+ me（sendkey/改密码）+ admin 三件（邀请码/预算/全量补跑）
//   ③ rate limit：per-IP 固定窗口（auth 5/min，API 60/min——DESIGN 写令牌桶，固定窗口是其简化实现，够用）
//   ④ CORS 拿掉 v1 的 `*`：v2 公网同源部署（H5 由本服务托管；dev 走 vite proxy 也同源）
//   ⑤ POST /api/run 只跑当前用户（admin 可 ?all=true）——烧预算的事最小授权
// 跑法：node 12-capstone/daily-brief-v2/server.ts（V2_PORT 默认 8788；首码见启动日志 bootstrap）
import 'dotenv/config'
import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { z } from 'zod'
import * as users from './users.ts'
import { budgetExceeded, type Budget } from './pipeline.ts'
import { TOPIC_PRESETS } from './presets.ts'
import { lanIPv4 } from './lan.ts'

const DIR = import.meta.dirname
const DATA = process.env.V2_DATA_DIR ? path.resolve(process.env.V2_DATA_DIR) : path.join(DIR, 'data')
const REPORTS = path.join(DATA, 'reports')
const REPO_ROOT = path.resolve(DIR, '../../..')
const PORT = Number(process.env.V2_PORT || 8788)

// ---------- TLS：密码与会话 cookie 绝不能在明文通道上走 ----------
// 登录密码、sid cookie 一旦裸奔在 HTTP 上，同一 WiFi/链路上的任何人抓包就拿到了账号。
// 应用层怎么折腾都救不了（客户端哈希=等价口令、可重放；WebCrypto 在 http://内网IP 下压根不可用），
// 正确且唯一的答案是让通道加密：
//   ① 本进程直接 HTTPS：配 V2_TLS_CERT / V2_TLS_KEY（局域网自签证书见 make-cert.sh）
//   ② 反向代理终结 TLS（Cloudflare Tunnel / Caddy / nginx）：本进程仍是 HTTP，用 V2_HTTPS=1 声明
//      「对外是 https」——这决定 cookie 是否加 Secure、是否发 HSTS
const TLS_CERT = process.env.V2_TLS_CERT ? path.resolve(process.env.V2_TLS_CERT) : ''
const TLS_KEY = process.env.V2_TLS_KEY ? path.resolve(process.env.V2_TLS_KEY) : ''
const TLS_ON = !!(TLS_CERT && TLS_KEY)
const SECURE = TLS_ON || process.env.V2_HTTPS === '1'

// ---------- 工具 ----------
const json = (res: http.ServerResponse, code: number, data: unknown) => {
	res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' })
	res.end(JSON.stringify(data))
}
const readJSON = async <T>(file: string, fallback: T): Promise<T> => {
	try {
		return JSON.parse(await fs.readFile(file, 'utf8')) as T
	} catch (err: any) {
		if (err?.code !== 'ENOENT') throw err
		return fallback
	}
}
// 日期统一 UTC（toISOString 前 10 位）——必须与产线落盘命名完全同口径（report/status/progress/budget
// 文件名都是产线用 toISOString 起的名）；换成东八区本地日期会在 00:00~08:00 窗口对不上盘上的文件
const today = () => new Date().toISOString().slice(0, 10)
// 客户端错误（body 超限/坏 JSON）→ 映射 4xx，别落进外层 500
class ClientError extends Error {
	code: 400 | 413
	constructor(message: string, code: 400 | 413 = 400) {
		super(message)
		this.code = code
	}
}
// body 限额：恶意大包打爆内存的最低防线（topics 数组 100KB 绰绰有余）
async function readBody(req: http.IncomingMessage, limit = 100_000): Promise<string> {
	let body = ''
	for await (const chunk of req) {
		body += chunk
		if (body.length > limit) throw new ClientError('请求体过大（上限 100KB）', 413)
	}
	return body
}
async function readJSONBody(req: http.IncomingMessage): Promise<any> {
	const raw = await readBody(req)
	try {
		return JSON.parse(raw)
	} catch {
		throw new ClientError('请求体不是合法 JSON')
	}
}
const getCookie = (req: http.IncomingMessage, name: string): string | undefined => {
	const m = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(req.headers.cookie ?? '')
	return m?.[1]
}
// session cookie：HttpOnly（JS 读不到 token）+ SameSite=Lax（跨站 POST 不带 cookie）。
// Secure 只在通道真加密时加——HTTP 下加了浏览器直接拒收（登不上），所以由 TLS_ON/V2_HTTPS 决定
const cookieFlags = `HttpOnly; Path=/; SameSite=Lax${SECURE ? '; Secure' : ''}`
const setSessionCookie = (res: http.ServerResponse, token: string) =>
	res.setHeader('Set-Cookie', `sid=${token}; Max-Age=${30 * 86400}; ${cookieFlags}`)
const clearSessionCookie = (res: http.ServerResponse) => res.setHeader('Set-Cookie', `sid=; Max-Age=0; ${cookieFlags}`)

// ---------- rate limit：per-IP 固定窗口（60s 窗口，惰性过期重置；重启清零可接受） ----------
// 桶按 (ip, 端点档) 分家——验收实录：只按 ip 分键时，/api/admin 等普通调用也往 auth 的
// 5/min 桶里计数，第 4 个 auth 请求就被 429（auth 限流被普通流量殃及）
const rlBuckets = new Map<string, { count: number; resetAt: number }>()
function rateLimited(key: string, limit: number): boolean {
	const now = Date.now()
	const b = rlBuckets.get(key)
	if (!b || b.resetAt < now) {
		rlBuckets.set(key, { count: 1, resetAt: now + 60_000 })
		return false
	}
	b.count++
	return b.count > limit
}

// ---------- 补跑（spawn 产线；全局单飞：预算记账虽串行，同时多 spawn 打外部 API 没必要） ----------
let running = false
async function triggerRun(uid: string | null): Promise<{ code: number; data: unknown }> {
	if (running) return { code: 409, data: { running: true, message: '已有补跑在途，等它落盘' } }
	running = true // 先占座再 await（占座与检查之间无 await = 事件循环内原子，两个并发 POST 不会双跑）
	// 同日重跑=新流：spawn 前先清旧 progress——SSE 是「连接即回放」，而子进程要 ~2s 才起，
	// 不先清的话客户端先把上一轮（可能失败）的整段事件收进来（用户实录：失败后重跑拿到旧事件流）
	const targets = uid ? [uid] : (await users.listUsers()).map((u) => u.id)
	await Promise.all(targets.map((id) => fs.rm(path.join(REPORTS, id, `progress-${today()}.json`), { force: true })))
	const args = [path.join(DIR, 'pipeline.ts')]
	if (uid) args.push('--user', uid)
	const child = spawn(process.execPath, args, { cwd: REPO_ROOT, env: process.env }) // cwd 钉仓库根（dotenv 从 cwd 读 .env，v1 教训）
	child.stdout?.on('data', (d) => console.log(`[pipeline] ${String(d).trim()}`))
	child.stderr?.on('data', (d) => console.error(`[pipeline:err] ${String(d).trim()}`)) // stdio:'ignore' 吞崩溃现场是黑盒（v1 教训）
	child.on('error', (err) => {
		running = false
		console.error('[run] spawn 失败：', err?.message)
	})
	child.on('exit', (code) => {
		running = false
		console.log(`[run] 产线子进程退出 code=${code}`)
	})
	console.log(`[run] 补跑已触发 pid=${child.pid}${uid ? ` uid=${uid.slice(0, 8)}…` : '（全员）'}`)
	return { code: 202, data: { started: true, pid: child.pid } }
}

// ---------- SSE：progress 文件即总线（v1 形状），客户端按 (uid, date) 归组各自 diff ----------
interface SseClient { res: http.ServerResponse; uid: string; date: string; sent: number }
const sseClients = new Set<SseClient>()
async function broadcastUserProgress(uid: string, date: string) {
	const events = (await readJSON<unknown[]>(path.join(REPORTS, uid, `progress-${date}.json`), [])) ?? []
	for (const c of sseClients) {
		if (c.uid !== uid || c.date !== date) continue
		// 流被重置（同日重跑 rm 后从 0 重新 append）：盘上事件数 < 已推数 = 新一轮开始了——
		// 发 reset 信号让客户端清空时间线、游标归零重放。不处理的话 length 永远追不上旧游标，
		// 新事件一次也推不出去，客户端冻死在上一轮的旧流上（用户实录的重跑 bug 第二层）
		if (events.length < c.sent) {
			c.res.write(`data: ${JSON.stringify({ ts: new Date().toISOString(), stage: 'reset', message: '新一轮开始' })}\n\n`)
			c.sent = 0
		}
		if (events.length > c.sent) {
			for (const ev of events.slice(c.sent)) c.res.write(`data: ${JSON.stringify(ev)}\n\n`)
			c.sent = events.length
		}
	}
}
// 递归 watch（Windows 支持 recursive）：reports/<uid>/progress-日期.json 变化 → 只广播该用户该日期。
// 注册放启动 IIFE 里 mkdir 之后（验收实录：挂模块顶层=跑在 mkdir 前，全新数据目录 ENOENT 崩在 import）

// ---------- 校验 ----------
const SourceSpecSchema = z.object({ type: z.enum(['hn', 'github', 'arxiv', 'rss']), query: z.string().min(1) })
const TopicSchema = z.object({ id: z.string().min(1), name: z.string().min(1), focus: z.string(), sources: z.array(SourceSpecSchema).min(1) })
const SubscriptionsSchema = z.object({ audience: z.string().min(1), topics: z.array(TopicSchema) })

// ---------- server ----------
async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
	const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
	const route = `${req.method} ${url.pathname}`
	const ip = req.socket.remoteAddress ?? '?'
	try {
		// 通道加密了才发 HSTS（HTTP 下发了没意义，还会把浏览器锁死在用户的例外里）
		if (SECURE) res.setHeader('Strict-Transport-Security', 'max-age=31536000')
		// 限流分两档：auth 端点 5/min（爆破面），其余 API 60/min；静态不限
		const isAuth = url.pathname.startsWith('/api/auth/')
		if (url.pathname.startsWith('/api/') && rateLimited(`${ip}:${isAuth ? 'auth' : 'api'}`, isAuth ? 5 : 60))
			return json(res, 429, { error: '请求太频繁，一分钟后再试' })

		const user = await users.getSessionUser(getCookie(req, 'sid') ?? '')
		const needAuth = () => {
			if (!user) {
				json(res, 401, { error: '请先登录' })
				return true
			}
			return false
		}

		// ---- auth：注册（成功即登录）/ 登录 / 登出 ----
		if (url.pathname === '/api/auth/register' && req.method === 'POST') {
			const b = await readJSONBody(req)
			const r = await users.register(String(b.username ?? ''), String(b.password ?? ''), String(b.inviteCode ?? ''))
			if (r.error || !r.user) return json(res, 400, { error: r.error })
			const l = await users.login(r.user.username, String(b.password))
			setSessionCookie(res, l.token!)
			return json(res, 200, { username: r.user.username, admin: r.user.admin })
		}
		if (url.pathname === '/api/auth/login' && req.method === 'POST') {
			const b = await readJSONBody(req)
			const l = await users.login(String(b.username ?? ''), String(b.password ?? ''))
			if (l.error || !l.token) return json(res, 401, { error: l.error })
			setSessionCookie(res, l.token)
			return json(res, 200, { ok: true })
		}
		if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
			const t = getCookie(req, 'sid')
			if (t) await users.logout(t)
			clearSessionCookie(res)
			return json(res, 200, { ok: true })
		}
		// 忘记密码的自救入口（登录页调用，无 session）：用户名+admin 发的重置码+新密码
		if (url.pathname === '/api/auth/reset' && req.method === 'POST') {
			const b = await readJSONBody(req)
			const r = await users.resetPassword(String(b.username ?? ''), String(b.code ?? ''), String(b.newPassword ?? ''))
			return r.ok ? json(res, 200, { ok: true }) : json(res, 400, { error: r.error })
		}

		// ---- me：自己的信息 / 填 sendkey / 改密码 ----
		if (url.pathname === '/api/me' && req.method === 'GET') {
			if (needAuth()) return
			return json(res, 200, {
				username: user!.username,
				admin: user!.admin,
				sendkeyMasked: user!.sendkey ? `${user!.sendkey.slice(0, 6)}…` : null,
			})
		}
		if (url.pathname === '/api/me' && req.method === 'PUT') {
			if (needAuth()) return
			const b = await readJSONBody(req)
			const u = await users.updateProfile(user!.id, { sendkey: b.sendkey === undefined ? undefined : String(b.sendkey) })
			return json(res, 200, { saved: true, sendkeyMasked: u?.sendkey ? `${u.sendkey.slice(0, 6)}…` : null })
		}
		if (url.pathname === '/api/me/password' && req.method === 'PUT') {
			if (needAuth()) return
			const b = await readJSONBody(req)
			const r = await users.changePassword(user!.id, String(b.oldPassword ?? ''), String(b.newPassword ?? ''))
			return r.ok ? json(res, 200, { ok: true }) : json(res, 400, { error: r.error })
		}

		// ---- 订阅（当前人）+ 预置话题库 ----
		if (req.method === 'GET' && url.pathname === '/api/topic-presets') {
			if (needAuth()) return
			return json(res, 200, { presets: TOPIC_PRESETS })
		}
		if (url.pathname === '/api/topics') {
			if (needAuth()) return
			const file = path.join(DATA, 'users', user!.id, 'subscriptions.json')
			if (req.method === 'GET') return json(res, 200, await readJSON(file, { audience: '关注科技动态的读者', topics: [] }))
			if (req.method === 'POST') {
				const parsed = SubscriptionsSchema.safeParse(await readJSONBody(req))
				if (!parsed.success) return json(res, 400, { error: '订阅格式不对', issues: parsed.error.issues.slice(0, 3) })
				await fs.mkdir(path.dirname(file), { recursive: true })
				await fs.writeFile(file, JSON.stringify(parsed.data, null, '\t'), 'utf8')
				console.log(`[topics] ${user!.username} 更新订阅：${parsed.data.topics.length} 个主题`)
				return json(res, 200, { saved: parsed.data.topics.length })
			}
		}

		// ---- 日报全家桶 / 指定日期（当前人） ----
		if (req.method === 'GET' && (url.pathname === '/api/latest' || url.pathname === '/api/report')) {
			if (needAuth()) return
			const dir = path.join(REPORTS, user!.id)
			// 倒序（新→旧）：默认取 dates[0]=最新，日期选择器也不用翻到底
			const dates = (await fs.readdir(dir).catch(() => [] as string[]))
				.map((f) => /^(\d{4}-\d{2}-\d{2})\.md$/.exec(f)?.[1])
				.filter((d): d is string => !!d)
				.sort((a, b) => b.localeCompare(a))
			if (dates.length === 0) return json(res, 404, { error: '还没有日报（配好订阅后点「生成」或等每天 09:00）' })
			const date = url.searchParams.get('date') ?? dates[0]
			const markdown = await fs.readFile(path.join(dir, `${date}.md`), 'utf8').catch(() => null)
			if (markdown === null) return json(res, 404, { error: `${date} 没有日报`, available: dates })
			return json(res, 200, {
				date,
				markdown,
				status: await readJSON(path.join(dir, `status-${date}.json`), null),
				progress: await readJSON(path.join(dir, `progress-${date}.json`), []),
				running,
				available: dates,
			})
		}

		// ---- 台账 / 进度（当前人） ----
		if (req.method === 'GET' && url.pathname === '/api/history') {
			if (needAuth()) return
			const h = await readJSON(path.join(REPORTS, user!.id, 'history.json'), null)
			return h ? json(res, 200, h) : json(res, 404, { error: '还没有台账' })
		}
		if (req.method === 'GET' && url.pathname === '/api/progress') {
			if (needAuth()) return
			const date = url.searchParams.get('date') ?? today()
			return json(res, 200, { date, events: await readJSON(path.join(REPORTS, user!.id, `progress-${date}.json`), []), running })
		}

		// ---- SSE（当前人，date 缺省今天） ----
		if (req.method === 'GET' && url.pathname === '/api/events') {
			if (needAuth()) return
			const date = url.searchParams.get('date') ?? today()
			res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
			res.write(`data: ${JSON.stringify({ ts: new Date().toISOString(), stage: 'connected', message: 'SSE 已连接（18s 心跳）' })}\n\n`)
			const client: SseClient = { res, uid: user!.id, date, sent: 0 }
			sseClients.add(client)
			broadcastUserProgress(user!.id, date).catch(() => {}) // 连接即回放
			const hb = setInterval(() => res.write(': heartbeat\n\n'), 18_000)
			req.on('close', () => {
				clearInterval(hb)
				sseClients.delete(client)
			})
			return
		}

		// ---- 补跑：只跑自己（admin 可 ?all=true 全员） ----
		if (req.method === 'POST' && url.pathname === '/api/run') {
			if (needAuth()) return
			if (!user!.admin && url.searchParams.get('all') === 'true') return json(res, 403, { error: '只有管理员能全量补跑' })
			const r = await triggerRun(user!.admin && url.searchParams.get('all') === 'true' ? null : user!.id)
			return json(res, r.code, r.data)
		}

		// ---- admin：邀请码 / 预算 ----
		if (url.pathname.startsWith('/api/admin/')) {
			if (needAuth()) return
			if (!user!.admin) return json(res, 403, { error: '只有管理员' })
			if (url.pathname === '/api/admin/invites' && req.method === 'POST') {
				const code = await users.createInvite(user!.id)
				return json(res, 200, { code })
			}
			if (url.pathname === '/api/admin/invites' && req.method === 'GET') return json(res, 200, await users.listInvites())
			// 用户列表 + 重置码：忘记密码的运营侧入口（码线下转交，无邮件依赖）
			if (url.pathname === '/api/admin/users' && req.method === 'GET') {
				const list = await users.listUsers()
				return json(res, 200, list.map((u) => ({ username: u.username, admin: u.admin, createdAt: u.createdAt })))
			}
			if (url.pathname === '/api/admin/reset-code' && req.method === 'POST') {
				const b = await readJSONBody(req)
				const r = await users.createResetCode(user!.id, String(b.username ?? ''))
				return r.code ? json(res, 200, { code: r.code }) : json(res, 400, { error: r.error })
			}
			if (url.pathname === '/api/admin/budget' && req.method === 'GET') {
				const b = await readJSON<Budget>(path.join(DATA, `budget-${today()}.json`), { date: today(), calls: 0, promptTokens: 0, completionTokens: 0 })
				return json(res, 200, {
					...b,
					limits: { calls: Number(process.env.DAILY_BUDGET_CALLS || 200), tokens: Number(process.env.DAILY_BUDGET_TOKENS || 500000) },
					exceeded: await budgetExceeded(),
				})
			}
		}

		// ---- 静态：uniapp 构建产物（dist/build/h5 插件约定路径），hash 路由免回退 ----
		// 路径穿越：new URL() 归一化吃掉 /../ 段，%2e%5c 等编码字元不解码——读取路径永远在 dist 下
		// mime 全表：woff/ttf 给 application/octet-stream 会被浏览器 font-face 拒载（uniapp 产物带字体）
		const MIME: Record<string, string> = {
			js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', html: 'text/html', json: 'application/json',
			png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml',
			ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', map: 'application/json',
		}
		if (req.method === 'GET' && (url.pathname === '/' || url.pathname.startsWith('/assets/') || url.pathname.startsWith('/static/'))) {
			const dist = path.join(DIR, 'app', 'dist', 'build', 'h5')
			const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
			const content = await fs.readFile(path.join(dist, file)).catch(() => null)
			if (content !== null) {
				const type = MIME[file.split('.').pop() ?? ''] ?? 'application/octet-stream'
				res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'X-Content-Type-Options': 'nosniff' })
				return res.end(content)
			}
			if (url.pathname === '/') {
				res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
				return res.end('<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>情报日报</title></head><body><p style="font-family:system-ui;padding:2em">前端产物未构建：cd 12-capstone/daily-brief-v2/app && npm run build:h5</p></body></html>')
			}
		}

		json(res, 404, { error: `没这个路由：${route}` })
	} catch (err: any) {
		if (err instanceof ClientError) return json(res, err.code, { error: err.message })
		console.error(`[server] ${route} 炸了：`, err?.message)
		json(res, 500, { error: err?.message })
	}
}

const server = TLS_ON
	? https.createServer({ cert: fsSync.readFileSync(TLS_CERT), key: fsSync.readFileSync(TLS_KEY) }, handle)
	: http.createServer(handle)

// ---------- 启动 ----------
;(async () => {
	await fs.mkdir(REPORTS, { recursive: true }) // fs.watch 的目标必须存在
	fsSync.watch(REPORTS, { recursive: true }, (_ev, file) => {
		const m = /([0-9a-f]{16})[\\/]progress-(\d{4}-\d{2}-\d{2})\.json$/.exec(file ?? '')
		if (m) broadcastUserProgress(m[1], m[2]).catch(() => {})
	})
	await users.bootstrap() // 零用户时打印首码（只此一次）
	server.listen(PORT, () => {
		const lan = lanIPv4()
		const scheme = TLS_ON ? 'https' : 'http'
		console.log(`[daily-brief-v2 server] ${scheme}://localhost:${PORT} · 局域网: ${lan ? `${scheme}://${lan}:${PORT}` : '（未找到局域网地址）'}`)
		console.log(`[daily-brief-v2 server] 注册=POST /api/auth/register · 登录=POST /api/auth/login · 补跑=POST /api/run · SSE=GET /api/events`)
		if (!SECURE)
			// 明文警告每次启动都打：这不是「警告过就算了」的合规条款，是「现在真有人在裸奔」的事实
			console.warn(`[daily-brief-v2 server] ⚠ 未加密（HTTP）：登录密码与会话 cookie 全程明文，同网段可被嗅探。局域网家用可接受；公网部署必须配 TLS（V2_TLS_CERT/V2_TLS_KEY 或代理终结 + V2_HTTPS=1，见 make-cert.sh）`)
	})
})()
