// API 层：全部相对路径（dev 走 vite proxy → 8787，prod 同源直连 server.ts 静态托管）
// SSE 双通道是 §7 交付形态调研的落地：H5 原生 EventSource（实测可用）；App 端（未来 Android 包）
// JS 环境无 EventSource → 轮询 /api/progress 降级（server 专门留的通道）——调研时定的「不行就轮询」
export interface ProgressEvent {
	ts: string
	stage: string
	message: string
}

export interface ReportPayload {
	date: string
	markdown: string
	status: { verdict?: { pass: boolean; issues: string[] }; topics?: Array<{ id: string; name: string; raw: number; selected: number; digest: string; sourceErrors: string[] }> } | null
	progress: ProgressEvent[]
	running: boolean
	available: string[]
}

export interface Topic {
	id: string
	name: string
	focus: string
	hnQuery: string
	githubQuery: string
}

async function get<T>(path: string): Promise<T> {
	const res = await fetch(path)
	if (!res.ok) throw new Error(`${res.status} ${await res.text().then((t) => t.slice(0, 120))}`)
	return res.json()
}

export const fetchReport = (date?: string) => get<ReportPayload>(date ? `/api/report?date=${date}` : '/api/latest')
export const fetchHistory = () => get<any>('/api/history')
export const fetchTopics = () => get<{ topics: Topic[] }>('/api/topics')

export async function saveTopics(topics: Topic[]): Promise<{ saved: number }> {
	const res = await fetch('/api/topics', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ topics }),
	})
	const body = await res.json()
	if (!res.ok) throw Object.assign(new Error('订阅清单格式不对'), { issues: body.issues })
	return body
}

export async function triggerRun(): Promise<{ started?: boolean; running?: boolean; message?: string }> {
	const res = await fetch('/api/run', { method: 'POST' })
	return res.json()
}

// 进度终态判定（server 的 running 只覆盖它自己 spawn 的产线——cron 起的它不知道；
// 统一用「progress 流里出现终态事件」判定，双场景通吃）
const TERMINAL = ['done', 'notify', 'error']
export const isTerminal = (events: ProgressEvent[]) => events.some((e) => TERMINAL.includes(e.stage))

/**
 * 监听产线进度。onEvent 逐条回调（连接时先回放已发生的事件——中途连上也能看全程）。
 * 返回取消函数。H5 走 SSE；App 端轮询降级（3s 一拉增量）。
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
		return () => es.close()
	}
	// 轮询降级：按已见事件数 diff 增量（server 端 SSE 同款逻辑）
	let seen = 0
	const timer = setInterval(async () => {
		try {
			const j = await get<{ events: ProgressEvent[] }>('/api/progress')
			j.events.slice(seen).forEach(onEvent)
			seen = j.events.length
		} catch {
			/* 单次拉失败不断流 */
		}
	}, 3000)
	return () => clearInterval(timer)
}
