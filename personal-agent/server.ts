// 个人 Agent 工作台 · 服务端
//
// 零依赖 http（v2 server 同款形态：够用就不引框架）。默认只绑 127.0.0.1——
// 个人工具不暴露局域网（要手机用再 PA_HOST=0.0.0.0；注意 http://局域网IP 不是 secure context，
// 浏览器剪贴板 API 会不可用，UI 有 execCommand 兜底）。
//
// 两个面板：
//   /api/chat   —— 常规 agent 对话：文本+图片+文本附件，流式 SSE，模型/思考强度可选
//   /api/ocr    —— 截图取字：本地 tesseract 或视觉 LLM 两条路线
//
// 前端是 Vue 3 + Vite（源码 personal-agent/web/），构建产物在 personal-agent/public/：
//   npm run pa:build   # 一次性构建，server 直接托管
//   npm run pa:web     # 或者起 Vite 开发服务器（5173，/api 代理到 8798）
//
// 跑法：node personal-agent/server.ts   →  http://127.0.0.1:8798
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { recognize, terminateOcr } from './ocr.ts'
import { recognizeWithAI } from './vision-ocr.ts'
import { translateLines } from './translate.ts'
import { MODELS, DEFAULT_MODEL_ID, THINKING_LEVELS, thinkingParams } from './models.ts'
import { normalizeMessages, lastUserHasImages, type ChatMessage, type ChatUsage } from './chat.ts'

const DIR = import.meta.dirname
const PUBLIC_DIR = path.join(DIR, 'public')
const PORT = Number(process.env.PA_PORT || 8798)
const HOST = process.env.PA_HOST || '127.0.0.1'
const MAX_BODY = 25 * 1024 * 1024 // 截图/图片附件一般在几 MB；25MB 上限防误打爆

const STATIC_MIME: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.ico': 'image/x-icon',
	'.json': 'application/json; charset=utf-8',
	'.woff2': 'font/woff2',
}

/** 托管 Vue 构建产物（frontend 源码在 web/，构建输出到 public/）。返回 false = 没这个文件 */
async function serveStatic(pathname: string, res: http.ServerResponse): Promise<boolean> {
	let rel: string
	try {
		rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '')
	} catch {
		return false
	}
	const file = path.resolve(PUBLIC_DIR, rel)
	if (!file.startsWith(PUBLIC_DIR + path.sep)) return false // 防 ../ 目录穿越
	try {
		const data = await fs.readFile(file)
		res.writeHead(200, {
			'Content-Type': STATIC_MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
			// 产物文件名固定（方便 git diff），所以不能长缓存——每次协商，避免换版后拿旧 JS
			'Cache-Control': 'no-cache',
		})
		res.end(data)
		return true
	} catch {
		return false
	}
}

const json = (res: http.ServerResponse, code: number, data: unknown) => {
	res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
	res.end(JSON.stringify(data))
}

async function readBody(req: http.IncomingMessage): Promise<string> {
	const chunks: Buffer[] = []
	let size = 0
	for await (const chunk of req) {
		size += chunk.length
		if (size > MAX_BODY) throw Object.assign(new Error('请求体太大（上限 25MB）'), { code: 413 })
		chunks.push(Buffer.from(chunk))
	}
	return Buffer.concat(chunks).toString('utf8')
}

// "data:image/png;base64,xxx" 或裸 base64 都收
function decodeImage(input: string): Buffer {
	const m = /^data:image\/[a-z0-9.+-]+;base64,(.*)$/is.exec(input)
	const b64 = m ? m[1] : input
	const buf = Buffer.from(b64, 'base64')
	if (buf.length === 0) throw Object.assign(new Error('图片解码为空'), { code: 400 })
	return buf
}

// ---------- 对话：流式 SSE（前端用 fetch reader 解析，不用 EventSource——POST 带 body） ----------
async function handleChat(req: http.IncomingMessage, res: http.ServerResponse) {
	const body = JSON.parse(await readBody(req)) as {
		messages?: ChatMessage[]
		modelId?: string
		thinking?: string
		imageElision?: boolean
	}
	const messagesIn = body.messages ?? []
	const entry = MODELS.find((m) => m.id === body.modelId) ?? MODELS.find((m) => m.id === DEFAULT_MODEL_ID)!
	// 图片能力前置校验：把「模型不支持图片」这种可预期错误挡在流开始前，别让用户对着 cryptic 上游报错猜
	if (lastUserHasImages(messagesIn) && !entry.vision)
		return json(res, 400, { error: `「${entry.label} · ${entry.model}」不支持图片输入——请切换到视觉模型` })

	const messages = normalizeMessages(messagesIn, body.imageElision !== false)
	res.writeHead(200, {
		'Content-Type': 'text/event-stream; charset=utf-8',
		'Cache-Control': 'no-cache',
		Connection: 'keep-alive',
		'X-Accel-Buffering': 'no',
	})
	const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`)

	// 客户端断开 → abort 上游，别让已经没人看的长回答继续烧 token
	const ac = new AbortController()
	res.on('close', () => {
		if (!res.writableEnded) ac.abort()
	})
	const t0 = Date.now()
	try {
		const stream = (await entry.client.chat.completions.create(
			{
				model: entry.model,
				messages,
				stream: true,
				stream_options: { include_usage: true }, // 最后一帧带完整 usage（cached/reasoning 明细）
				...thinkingParams(body.thinking ?? 'off'),
			} as any,
			{ signal: ac.signal },
		)) as any
		let text = ''
		let usage: ChatUsage = null
		for await (const chunk of stream) {
			if (chunk.usage) usage = chunk.usage
			const delta = chunk.choices?.[0]?.delta?.content
			if (delta) {
				text += delta
				send({ type: 'delta', text: delta })
			}
		}
		send({ type: 'done', text, usage, model: entry.model, modelId: entry.id, elapsedMs: Date.now() - t0 })
		console.log(`[pa] chat ${entry.id}(${entry.model}) · ${text.length} 字 · ${usage?.total_tokens ?? '?'} tokens · ${Date.now() - t0}ms`)
	} catch (err: any) {
		if (!ac.signal.aborted) send({ type: 'error', error: String(err?.message ?? err).slice(0, 300) })
	}
	res.end()
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
	const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
	try {
		// 前端静态资源（Vue 构建产物）；/api/* 走下面的接口
		if (req.method === 'GET' && !url.pathname.startsWith('/api')) {
			if (await serveStatic(url.pathname, res)) return
			return json(res, 404, {
				error: `没这个文件：${url.pathname}${url.pathname === '/' ? '（先跑 npm run pa:build 生成 frontend）' : ''}`,
			})
		}

		// 模型目录 + 思考档位（UI 下拉框数据源）
		if (req.method === 'GET' && url.pathname === '/api/models') {
			return json(res, 200, {
				models: MODELS.map(({ id, label, model, vision }) => ({ id, label, model, vision })),
				defaultModelId: DEFAULT_MODEL_ID,
				thinkingLevels: THINKING_LEVELS,
			})
		}

		if (req.method === 'POST' && url.pathname === '/api/chat') return await handleChat(req, res)

		if (req.method === 'POST' && url.pathname === '/api/ocr') {
			const body = JSON.parse(await readBody(req)) as { image?: string; engine?: string }
			if (!body.image) return json(res, 400, { error: '缺 image 字段（dataURL 或 base64）' })
			const image = decodeImage(body.image)
			// 两条识别路线（模块 13 对照作业）：local=本地 tesseract（默认，带坐标）；ai=视觉 LLM（版式强、无坐标）
			const engine = body.engine === 'ai' ? 'ai' : 'local'
			const t0 = Date.now()
			const ocr = engine === 'ai' ? await recognizeWithAI(image) : await recognize(image)
			// OCR 秒级返回先给用户；翻译另有网络延迟——可选 ?translate=0 跳过（离线/省 token）
			let translations: { id: number; zh: string }[] = []
			let translateError: string | undefined
			let translateUsage: ChatUsage = null
			if (url.searchParams.get('translate') !== '0' && ocr.lines.length > 0) {
				const t = await translateLines(ocr.lines)
				translations = [...t.map].map(([id, zh]) => ({ id, zh }))
				translateError = t.error
				translateUsage = t.usage ?? null
			}
			console.log(
				`[pa] OCR(${ocr.engine}) ${ocr.lines.length} 行` +
					(typeof ocr.confidence === 'number' ? ` · 置信 ${Math.round(ocr.confidence)}` : '') +
					` · ${ocr.elapsedMs}ms · 翻译 ${translations.length} 行${translateError ? `（失败：${translateError}）` : ''} · 总 ${Date.now() - t0}ms`,
			)
			// usage / translateUsage 都是服务商原始对象（含 cached/reasoning 明细）；本地 OCR 无计费时缺省
			return json(res, 200, { ...ocr, translations, translateError, translateUsage })
		}

		json(res, 404, { error: `没这个路由：${req.method} ${url.pathname}` })
	} catch (err: any) {
		const code = [400, 413, 502].includes(err?.code) ? err.code : 500
		if (code === 500) console.error('[pa] 炸了：', err?.message)
		json(res, code, { error: err?.message ?? '未知错误' })
	}
}

const server = http.createServer(handle)
server.listen(PORT, HOST, () => {
	console.log(`[personal-agent] 工作台 → http://${HOST}:${PORT}`)
	console.log(`[personal-agent] 模型：${MODELS.map((m) => `${m.label}=${m.model}${m.vision ? '(视觉)' : ''}`).join(' · ')}`)
})

// Ctrl+C 收 worker（tesseract 的 wasm worker 不 terminate 会留一个子线程）
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
	process.on(sig, async () => {
		await terminateOcr()
		server.close()
		process.exit(0)
	})
}
