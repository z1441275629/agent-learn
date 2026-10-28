// API 层（v2）：全部相对路径（dev 走 vite proxy → 8788，prod 同源直连 v2 server 托管）
//
// 与 v1 的本质差别：登录态。cookie session 自动携带（同源 fetch 默认带 cookie），
// 401 统一拦截跳登录页——但 auth 三件（login/register/logout）不能走拦截：
// 登录的 401 是「密码错」不是「未登录」，拦了会在登录页里跳登录页。
export interface ProgressEvent {
	ts: string
	stage: string
	message: string
}

export interface ReportPayload {
	date: string
	markdown: string
	status: { verdict?: { pass: boolean; issues: string[] }; topics?: Array<{ id: string; name: string; raw: number; selected: number; digest: string; sourceErrors: string[] }>; skipped?: string } | null
	progress: ProgressEvent[]
	running: boolean
	available: string[]
}

// v2 订阅形状：sources 是数组（type 从注册表四选一），不再是 v1 的 hnQuery/githubQuery 双字段
export type SourceType = 'hn' | 'github' | 'arxiv' | 'rss'
export interface SourceSpec {
	type: SourceType
	query: string
}
export interface Topic {
	id: string
	name: string
	focus: string
	sources: SourceSpec[]
}
export interface Subscriptions {
	audience: string
	topics: Topic[]
}

export interface Me {
	username: string
	admin: boolean
	sendkeyMasked: string | null
}

const toLogin = () => uni.reLaunch({ url: '/pages/login/login' })

/**
 * 会话内端点统一入口：401 → 跳登录；业务错误 → throw Error（error.message 用 server 的中文提示；
 * zod issues 挂在 err.issues 上——topics 保存被拒时弹首条）
 */
async function request<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> {
	const res = await fetch(path, {
		method,
		headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
		body: body !== undefined ? JSON.stringify(body) : undefined,
	})
	if (res.status === 401) {
		toLogin()
		throw new Error('请先登录')
	}
	const data: any = await res.json().catch(() => null)
	if (!res.ok) {
		const err: any = new Error(data?.error ?? `${res.status} 请求失败`)
		if (data?.issues) err.issues = data.issues
		throw err
	}
	return data as T
}

// ---------- 会话内端点 ----------
export const fetchReport = (date?: string) => request<ReportPayload>(date ? `/api/report?date=${date}` : '/api/latest')
export const fetchHistory = () => request<any>('/api/history')
export const fetchTopics = () => request<Subscriptions>('/api/topics')
export const saveTopics = (subs: Subscriptions) => request<{ saved: number }>('/api/topics', 'POST', subs)
export const fetchMe = () => request<Me>('/api/me')
export const saveSendkey = (sendkey: string) => request<{ saved: boolean; sendkeyMasked: string | null }>('/api/me', 'PUT', { sendkey })
export const changePassword = (oldPassword: string, newPassword: string) => request<{ ok: boolean }>('/api/me/password', 'PUT', { oldPassword, newPassword })
export const triggerRun = () => request<{ started?: boolean; running?: boolean; message?: string }>('/api/run', 'POST')
// admin 三件（非 admin 403 → request throw「只有管理员」）
export const createInvite = () => request<{ code: string }>('/api/admin/invites', 'POST')
export const fetchInvites = () => request<Record<string, { usedBy?: string; usedAt?: string }>>('/api/admin/invites')
export const fetchBudget = () => request<{ calls: number; promptTokens: number; completionTokens: number; limits: { calls: number; tokens: number } }>('/api/admin/budget')

// ---------- auth 三件：不走 request（401=密码错≠未登录），错误原样给调用方 ----------
export async function login(username: string, password: string): Promise<{ ok: boolean; error?: string }> {
	const res = await fetch('/api/auth/login', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ username, password }),
	})
	const data: any = await res.json().catch(() => ({}))
	return res.ok ? { ok: true } : { ok: false, error: data?.error ?? `登录失败 ${res.status}` }
}

export async function register(username: string, password: string, inviteCode: string): Promise<{ ok: boolean; error?: string }> {
	const res = await fetch('/api/auth/register', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ username, password, inviteCode }),
	})
	const data: any = await res.json().catch(() => ({}))
	return res.ok ? { ok: true } : { ok: false, error: data?.error ?? `注册失败 ${res.status}` }
}

export async function logout(): Promise<void> {
	await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {})
}

// ---------- 进度通道（v1 形状：H5 原生 EventSource；App 端无 EventSource → 轮询降级） ----------
// 进度终态判定（server 的 running 只覆盖它自己 spawn 的产线——cron 起的它不知道；
// 统一用「progress 流里出现终态事件」判定，双场景通吃）
const TERMINAL = ['done', 'notify', 'error', 'skip']
export const isTerminal = (events: ProgressEvent[]) => events.some((e) => TERMINAL.includes(e.stage))

/**
 * 监听产线进度。onEvent 逐条回调（连接时先回放已发生的事件——中途连上也能看全程）。
 * 返回取消函数。H5 走 SSE（同源自动带 cookie）；App 端轮询降级（3s 一拉增量）。
 */
export function watchProgress(onEvent: (e: ProgressEvent) => void): () => void {
	if (typeof EventSource !== 'undefined') {
		const es = new EventSource('/api/events')
		es.onmessage = (m) => {
			try {
				onEvent(JSON.parse(m.data))
			} catch {
				/* 心跳注释行不进 onmessage，坏包忽略不炸流 */
			}
		}
		// SSE 半途 401（30 天 session 到期）：浏览器会自动重连空转——关掉它，
		// 下次页面 onShow 的 API 调用会走 401 拦截把用户送去登录
		es.onerror = () => es.close()
		return () => es.close()
	}
	// 轮询降级：按已见事件数 diff 增量（server 端 SSE 同款逻辑）
	let seen = 0
	const timer = setInterval(async () => {
		try {
			const j = await request<{ events: ProgressEvent[] }>('/api/progress')
			j.events.slice(seen).forEach(onEvent)
			seen = j.events.length
		} catch (err: any) {
			/* 单次拉失败不断流；401 已被 request 拦截跳登录——这里停表即可 */
			if (String(err?.message).includes('请先登录')) clearInterval(timer)
		}
	}, 3000)
	return () => clearInterval(timer)
}
