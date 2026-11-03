// 个人 Agent 工作台 · 服务端（模块 13 第一件：截图取字）
//
// 零依赖 http（v2 server 同款形态：够用就不引框架）。默认只绑 127.0.0.1——
// 个人工具不暴露局域网（要手机用再 PA_HOST=0.0.0.0；注意 http://局域网IP 不是 secure context，
// 浏览器剪贴板 API 会不可用，UI 有 execCommand 兜底）。
//
// 跑法：node personal-agent/server.ts   →  http://127.0.0.1:8798
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { recognize, terminateOcr } from './ocr.ts'
import { translateLines } from './translate.ts'

const DIR = import.meta.dirname
const PORT = Number(process.env.PA_PORT || 8798)
const HOST = process.env.PA_HOST || '127.0.0.1'
const MAX_BODY = 25 * 1024 * 1024 // 截图一般在 1MB 内；25MB 足够宽松又不至于被误打爆

const json = (res: http.ServerResponse, code: number, data: unknown) => {
	res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
	res.end(JSON.stringify(data))
}

async function readBody(req: http.IncomingMessage): Promise<string> {
	const chunks: Buffer[] = []
	let size = 0
	for await (const chunk of req) {
		size += chunk.length
		if (size > MAX_BODY) throw Object.assign(new Error('图片太大（上限 25MB）'), { code: 413 })
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

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
	const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
	try {
		if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
			const html = await fs.readFile(path.join(DIR, 'public', 'index.html'))
			res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
			return res.end(html)
		}
		if (req.method === 'POST' && url.pathname === '/api/ocr') {
			const body = JSON.parse(await readBody(req)) as { image?: string }
			if (!body.image) return json(res, 400, { error: '缺 image 字段（dataURL 或 base64）' })
			const image = decodeImage(body.image)
			const t0 = Date.now()
			const ocr = await recognize(image)
			// OCR 秒级返回先给用户；翻译另有网络延迟——可选 ?translate=0 跳过（离线/省 token）
			let translations: { id: number; zh: string }[] = []
			let translateError: string | undefined
			if (url.searchParams.get('translate') !== '0' && ocr.lines.length > 0) {
				const t = await translateLines(ocr.lines)
				translations = [...t.map].map(([id, zh]) => ({ id, zh }))
				translateError = t.error
			}
			console.log(
				`[pa] OCR ${ocr.lines.length} 行 · 置信 ${Math.round(ocr.confidence)} · ${ocr.elapsedMs}ms` +
					` · 翻译 ${translations.length} 行${translateError ? `（失败：${translateError}）` : ''} · 总 ${Date.now() - t0}ms`,
			)
			return json(res, 200, { ...ocr, translations, translateError })
		}
		json(res, 404, { error: `没这个路由：${req.method} ${url.pathname}` })
	} catch (err: any) {
		const code = err?.code === 413 ? 413 : err?.code === 400 ? 400 : 500
		if (code === 500) console.error('[pa] 炸了：', err?.message)
		json(res, code, { error: err?.message ?? '未知错误' })
	}
}

const server = http.createServer(handle)
server.listen(PORT, HOST, () => {
	console.log(`[personal-agent] 截图取字 → http://${HOST}:${PORT}`)
	console.log(`[personal-agent] 用法：Win+Shift+S 截图 → 页面里 Ctrl+V 粘贴 → 点任意一行复制`)
})

// Ctrl+C 收 worker（tesseract 的 wasm worker 不 terminate 会留一个子线程）
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
	process.on(sig, async () => {
		await terminateOcr()
		server.close()
		process.exit(0)
	})
}
