// 个人 Agent 工作台 · 服务端
//
// 零依赖 http（v2 server 同款形态：够用就不引框架）。默认只绑 127.0.0.1——
// 个人工具不暴露局域网（要手机用再 PA_HOST=0.0.0.0；注意 http://局域网IP 不是 secure context，
// 浏览器剪贴板 API 会不可用，UI 有 execCommand 兜底）。
//
// 两个面板：
//   /api/chat      —— 常规 agent 对话：文本+图片+文本附件，流式 SSE，模型/思考强度可选
//   /api/sessions  —— 会话账本：列表/详情/图片；对话状态在服务端，刷新/重启后可恢复
//   /api/ocr       —— 截图取字：本地 tesseract 或视觉 LLM 两条路线
//
// 前端是 Vue 3 + Vite（源码 personal-agent/web/），构建产物在 personal-agent/public/：
//   npm run pa:build   # 一次性构建，server 直接托管
//   npm run pa:web     # 或者起 Vite 开发服务器（5173，/api 代理到 8798）
//
// 跑法：node personal-agent/server.ts   →  http://127.0.0.1:8798
// 数据目录：PA_DATA_DIR（默认 personal-agent/data，sessions/ 在里面）
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { recognize, terminateOcr } from './ocr.ts'
import { recognizeWithAI } from './vision-ocr.ts'
import { translateLines } from './translate.ts'
import { MODELS, DEFAULT_MODEL_ID, THINKING_LEVELS, thinkingParams } from './models.ts'
import { buildApiMessages, deriveTitle, type ChatUsage } from './chat.ts'
import { loadConfig } from './core/config.ts'
import { createSessionStore, type SessionDoc, type StoredImage } from './core/sessions.ts'
import {
  createMemoryStore,
  extractMemories,
  memorySystemContent,
  mergeMemoryList,
  shouldAcceptExtraction,
} from './core/memories.ts'
import {
  applyWindow,
  messagesTokens,
  splitForCompaction,
  storedMessagesTokens,
  summarizeConversation,
} from './core/context.ts'

const DIR = import.meta.dirname
const PUBLIC_DIR = path.join(DIR, 'public')
const PORT = Number(process.env.PA_PORT || 8798)
const HOST = process.env.PA_HOST || '127.0.0.1'
const MAX_BODY = 25 * 1024 * 1024 // 截图/图片附件一般在几 MB；25MB 上限防误打爆
const config = loadConfig()
const store = createSessionStore(config.dataDir)
const memories = createMemoryStore(config.dataDir)
/** 同一会话同时只跑一轮：多标签页/重复点击时，后来的请求 409，避免账本写乱 */
const runningSessions = new Set<string>()

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

// ---------- 会话账本：给前端展示的形状（图片走独立 URL，不把 base64 塞回 JSON） ----------
function sessionDetail(doc: SessionDoc) {
  return {
    id: doc.id,
    title: doc.title,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    modelId: doc.modelId,
    thinking: doc.thinking,
    messages: doc.messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.text,
      images: m.images.map((im) => ({
        src: `/api/sessions/${doc.id}/images/${im.file}`,
        name: im.name,
      })),
      usage: m.usage,
      model: m.model,
      elapsedMs: m.elapsedMs,
      error: m.error,
      interrupted: m.interrupted,
    })),
  }
}

/** 保存失败只大声报错，不把正在进行的对话带崩（持久化是增强不是依赖） */
async function safeAppend(
  id: string,
  message: Parameters<typeof store.append>[1],
  opts?: Parameters<typeof store.append>[2],
): Promise<SessionDoc | null> {
  try {
    return await store.append(id, message, opts)
  } catch (err: any) {
    console.error(`[pa] 会话 ${id} 保存失败：${err?.message}`)
    return null
  }
}

// ---------- 上下文预算：摘要 + 滑窗（core/context.ts 的调度层） ----------
/**
 * 把会话账本变成这次要发给模型的 messages，并在超预算时按三层防线处理：
 *   ① 图片省略交给 buildApiMessages（旧图零 I/O）
 *   ② 旧轮 → LLM 摘要，摘要与截止点落盘（之后每轮只发「摘要 + 截止点之后」）
 *   ③ 摘要失败/仍超预算 → 滑动窗口按整轮丢最旧，最新一轮永远保留
 *
 * 摘要用 light 档并关思考：压缩是确定性的信息整理，不值得付主模型的价和推理预算。
 */
async function prepareContext(doc: SessionDoc, entry: (typeof MODELS)[number], elideOldImages: boolean) {
  const memoryEntries = config.memoryEnabled ? await memories.list() : []
  const buildView = async (messages: SessionDoc['messages'], summary: string | undefined) => {
    const api = await buildApiMessages(messages, {
      elideOldImages,
      loadImage: (file) => store.readImage(doc.id, file),
    })
    return [
      // 记忆是 system 前缀、摘要是 user 前缀——开窗时这两个前缀都要保住（prefixCount 见下）
      ...(memoryEntries.length ? [{ role: 'system', content: memorySystemContent(memoryEntries) }] : []),
      ...(summary ? [{ role: 'user', content: `【前情摘要】\n${summary}` }] : []),
      ...api,
    ]
  }
  const prefixLen = (memoryEntries.length ? 1 : 0) + (doc.summary ? 1 : 0)

  const view = await buildView(
    doc.messages.filter((m) => m.id > (doc.summaryUntil ?? 0)),
    doc.summary,
  )
  const tokens = messagesTokens(view)
  if (tokens <= config.contextBudget) return view

  const active = doc.messages.filter((m) => m.id > (doc.summaryUntil ?? 0))
  const plan = splitForCompaction(active, {
    budgetTokens: config.contextBudget,
    tokenOfTurn: (turn) => storedMessagesTokens(turn),
  })
  if (plan.summarize.length === 0) {
    console.warn(`[pa] 上下文 ${Math.round(tokens)} > 预算 ${config.contextBudget}，但没有可压缩的旧轮——开窗兜底`)
    return applyWindow(view, config.contextBudget, prefixLen)
  }

  const summarizer = MODELS.find((m) => m.id === 'light') ?? entry
  try {
    const result = await summarizeConversation(summarizer.client, summarizer.model, plan.summarize, doc.summary, {
      thinkingParams: thinkingParams('off'),
    })
    const until = Math.max(...plan.summarize.map((m) => m.id))
    await store.setSummary(doc.id, result.summary, until)
    doc.summary = result.summary
    doc.summaryUntil = until

    const next = await buildView(plan.retained, result.summary)
    const after = messagesTokens(next)
    console.log(
      `[pa] 上下文压缩：${Math.round(tokens)} → ${Math.round(after)} tokens` +
        `（摘要 ${result.promptTokens}+${result.completionTokens} tokens，覆盖到消息 ${until}）· session ${doc.id}`,
    )
    if (after > config.contextBudget) {
      console.warn(`[pa] 压缩后仍超预算——开窗兜底`)
      return applyWindow(next, config.contextBudget, memoryEntries.length + 1)
    }
    return next
  } catch (err: any) {
    console.error(`[pa] 摘要失败，退回滑动窗口：${err?.message ?? err}`)
    return applyWindow(view, config.contextBudget, prefixLen)
  }
}

// ---------- 记忆抽取钩子：回答完成后异步跑，绝不阻塞/弄崩对话 ----------
// 课程 07 的教训在这条链上全用得上：
//   - 不 await 的钩子里异常逃逸 = unhandled rejection 崩进程——必须自己消化
//   - 两个会话同时抽取 = 同一文件的读改写竞态——串行化（链式 promise）
//   - 输出不合法/清空式输出 = 守门拒绝、大声报错，记忆保持原样（静默丢记忆比崩溃更糟）
let memoryChain: Promise<void> = Promise.resolve()
function runMemoryExtraction(sid: string, turn: { userText: string; assistantText: string }): void {
  memoryChain = memoryChain
    .then(async () => {
      if (!config.memoryEnabled) return
      const extractor = MODELS.find((m) => m.id === 'light') ?? MODELS[0]
      const existing = await memories.list()
      const result = await extractMemories(
        extractor.client,
        extractor.model,
        existing.map((e) => e.text),
        [
          { role: 'user', text: turn.userText },
          { role: 'assistant', text: turn.assistantText },
        ],
        { thinkingParams: thinkingParams('off') },
      )
      if (!shouldAcceptExtraction(result.texts, existing.length)) {
        console.warn(`[pa] 记忆抽取想清空 ${existing.length} 条——拒绝（真要清空请用界面）`)
        return
      }
      const diff = mergeMemoryList(existing, result.texts)
      if (diff.added.length === 0 && diff.removed.length === 0) return // 没变化不写盘
      await memories.save(diff.entries)
      console.log(
        `[pa] 记忆更新：+${diff.added.length} -${diff.removed.length} → 共 ${diff.entries.length} 条` +
          `（抽取 ${result.promptTokens}+${result.completionTokens} tokens）· session ${sid}`,
      )
      for (const t of diff.added) console.log(`[pa] 记忆 + ${t}`)
      for (const t of diff.removed) console.log(`[pa] 记忆 - ${t}`)
    })
    .catch((err: any) => console.error(`[pa] 记忆抽取失败（本轮跳过，记忆保持原样）：${err?.message ?? err}`))
}

// ---------- 对话：服务端持有账本，客户端只发新消息；流式 SSE ----------
interface ChatBody {
  sessionId?: string | null
  message?: { text?: string; images?: { dataUrl?: string; name?: string }[] }
  modelId?: string
  thinking?: string
  imageElision?: boolean
}

async function handleChat(req: http.IncomingMessage, res: http.ServerResponse) {
  const body = JSON.parse(await readBody(req)) as ChatBody
  const entry = MODELS.find((m) => m.id === body.modelId) ?? MODELS.find((m) => m.id === DEFAULT_MODEL_ID)!
  const input = body.message
  if (!input || typeof input.text !== 'string')
    return json(res, 400, { error: '缺 message.text（新消息必须由客户端提供）' })
  const text = input.text
  const rawImages = Array.isArray(input.images) ? input.images : []
  if (!text.trim() && rawImages.length === 0) return json(res, 400, { error: '消息为空' })
  if (rawImages.length > 8) return json(res, 400, { error: '一轮最多 8 张图片' })
  // 图片能力前置校验放在动存储之前：失败的请求不许污染会话列表
  if (rawImages.length > 0 && !entry.vision)
    return json(res, 400, { error: `「${entry.label} · ${entry.model}」不支持图片输入——请切换到视觉模型` })

  const existing = body.sessionId ? await store.load(body.sessionId) : await store.create()
  if (!existing) return json(res, 404, { error: '会话不存在' })
  const sid = existing.id
  if (runningSessions.has(sid)) return json(res, 409, { error: '这个会话还在回答，先停止或等它结束' })
  runningSessions.add(sid)

  try {
    const storedImages: StoredImage[] = []
    for (const image of rawImages) {
      if (!image || typeof image.dataUrl !== 'string') return json(res, 400, { error: '图片缺 dataUrl' })
      storedImages.push(await store.saveImage(sid, image.dataUrl, image.name))
    }
    const doc = await store.append(
      sid,
      { role: 'user', text, images: storedImages },
      {
        title: deriveTitle(text, storedImages.length > 0),
        modelId: entry.id,
        thinking: body.thinking ?? 'off',
      },
    )

    const messages = await prepareContext(doc, entry, body.imageElision !== false)

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    const send = (o: unknown) => {
      if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(o)}\n\n`)
    }
    // 第一帧就告诉前端会话 id/标题：新会话由服务端创建，前端据此刷新列表
    send({ type: 'session', sessionId: sid, title: doc.title })

    // 客户端断开/点停止 → abort 上游，别让没人看的长回答继续烧 token；半截回答仍要落盘
    const ac = new AbortController()
    res.on('close', () => {
      if (!res.writableEnded) ac.abort()
    })
    const t0 = Date.now()
    let textOut = ''
    let usage: ChatUsage = null
    const saveInterrupted = async (elapsedMs: number) => {
      if (textOut) {
        await safeAppend(sid, {
          role: 'assistant',
          text: textOut,
          model: entry.model,
          elapsedMs,
          interrupted: true,
        })
      }
      console.log(`[pa] chat 已停止 · ${textOut.length} 字 · session ${sid}`)
    }
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
      for await (const chunk of stream) {
        if (chunk.usage) usage = chunk.usage
        const delta = chunk.choices?.[0]?.delta?.content
        if (delta) {
          textOut += delta
          send({ type: 'delta', text: delta })
        }
      }
      const elapsedMs = Date.now() - t0
      if (ac.signal.aborted) {
        // 关键实测：OpenAI SDK 的上游流被 abort 时常常是「正常结束」而不是抛错，
        // 所以不能只靠 catch 判断用户是否点了停止——循环结束后必须再看一次信号。
        await saveInterrupted(elapsedMs)
      } else {
        await safeAppend(sid, {
          role: 'assistant',
          text: textOut,
          usage,
          model: entry.model,
          elapsedMs,
        })
        send({
          type: 'done',
          text: textOut,
          usage,
          model: entry.model,
          modelId: entry.id,
          sessionId: sid,
          elapsedMs,
        })
        console.log(
          `[pa] chat ${entry.id}(${entry.model}) · ${textOut.length} 字 · ${usage?.total_tokens ?? '?'} tokens · ${elapsedMs}ms · session ${sid}`,
        )
        // 回答完整落盘后才抽记忆：半截/出错的回答不抽（对话可能还没说完）
        runMemoryExtraction(sid, { userText: text, assistantText: textOut })
      }
    } catch (err: any) {
      const elapsedMs = Date.now() - t0
      if (ac.signal.aborted) {
        // 用户主动停止：把已经生成的部分存进账本，下次进来还能接着聊
        await saveInterrupted(elapsedMs)
      } else {
        const msg = String(err?.message ?? err).slice(0, 300)
        // 失败的 assistant 消息落盘（error 非空）——界面能看到，但 buildApiMessages 会把它排除出上下文
        await safeAppend(sid, { role: 'assistant', text: '', error: msg, model: entry.model, elapsedMs })
        send({ type: 'error', error: msg })
      }
    }
    res.end()
  } finally {
    runningSessions.delete(sid)
  }
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

    // 会话列表 / 新会话 / 详情 / 图片
    if (req.method === 'GET' && url.pathname === '/api/sessions') {
      return json(res, 200, { sessions: await store.list() })
    }
    if (req.method === 'POST' && url.pathname === '/api/sessions') {
      const doc = await store.create()
      return json(res, 200, { session: sessionDetail(doc) })
    }
    const sessionMatch = /^\/api\/sessions\/([^/]+)$/.exec(url.pathname)
    if (sessionMatch) {
      const id = decodeURIComponent(sessionMatch[1])
      if (req.method === 'GET') {
        const doc = await store.load(id)
        if (!doc) return json(res, 404, { error: '会话不存在' })
        return json(res, 200, { session: sessionDetail(doc) })
      }
      if (req.method === 'DELETE') {
        await store.remove(id)
        return json(res, 200, { ok: true })
      }
    }
    const imageMatch = /^\/api\/sessions\/([^/]+)\/images\/([^/]+)$/.exec(url.pathname)
    if (req.method === 'GET' && imageMatch) {
      const image = await store.readImage(decodeURIComponent(imageMatch[1]), decodeURIComponent(imageMatch[2]))
      if (!image) return json(res, 404, { error: '图片不存在' })
      res.writeHead(200, {
        'Content-Type': image.mime,
        'Cache-Control': 'private, max-age=31536000, immutable',
      })
      return res.end(image.data)
    }

    // 记忆（跨会话长期记忆的查看/删除——用户能看到它记了什么，错了能删）
    if (req.method === 'GET' && url.pathname === '/api/memories') {
      return json(res, 200, { memories: await memories.list() })
    }
    if (req.method === 'DELETE' && url.pathname === '/api/memories') {
      await memories.clear()
      return json(res, 200, { ok: true })
    }
    const memoryMatch = /^\/api\/memories\/([^/]+)$/.exec(url.pathname)
    if (memoryMatch && req.method === 'DELETE') {
      const ok = await memories.remove(decodeURIComponent(memoryMatch[1]))
      if (!ok) return json(res, 404, { error: '没有这条记忆' })
      return json(res, 200, { ok: true })
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
    const code = [400, 404, 409, 413, 502].includes(err?.code) ? err.code : 500
    if (code === 500) console.error('[pa] 炸了：', err?.message)
    json(res, code, { error: err?.message ?? '未知错误' })
  }
}

const server = http.createServer(handle)
server.listen(PORT, HOST, () => {
  console.log(`[personal-agent] 工作台 → http://${HOST}:${PORT}`)
  console.log(`[personal-agent] 数据目录 → ${config.dataDir}（PA_DATA_DIR 可改）`)
  console.log(
    `[personal-agent] 模型：${MODELS.map((m) => `${m.label}=${m.model}${m.vision ? '(视觉)' : ''}`).join(' · ')}`,
  )
})

// Ctrl+C 收 worker（tesseract 的 wasm worker 不 terminate 会留一个子线程）
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await terminateOcr()
    server.close()
    process.exit(0)
  })
}
