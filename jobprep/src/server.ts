// 入口：HTTP + SSE 桥（S8 验证过的帧协议）+ 三 agent 路由（显式页签直选，设计稿 §5.2）
// 帧协议（pa 同款 SSE）：{type:'custom'|'question'|'done', ...}
//   custom   ← 图内 getWriter() 旁路事件（picked/graded/summary）
//   question ← 挂起时的题面（读 checkpointer 快照的 interrupt 载荷）
//   done     ← 流收口（带 ms；出错带 error）
// 会话：每功能独立 thread 命名空间 practice:{sessionId}（§5.8）；断线重连无 text 时补发挂起题面
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command } from '@langchain/langgraph'
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite'
import Database from 'better-sqlite3'
import { PROJECT_ROOT, env } from './env.ts'
import { loadBank } from './bank/loader.ts'
import { createPracticeGraph, createLlmJudge } from './agents/practice.ts'
import { STATUS as TRAIN_STATUS } from './agents/train.ts'
import { STATUS as RESUME_STATUS } from './agents/resume.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const bank = loadBank()
console.log(`[jobprep] 题库装载：${bank.length} 题（reviews × qa / PITFALLS × 排障）`)

fs.mkdirSync(path.join(PROJECT_ROOT, 'data'), { recursive: true })
const checkpointer = new SqliteSaver(new Database(path.join(PROJECT_ROOT, 'data', 'jobprep.db')))
const practice = createPracticeGraph({ judge: createLlmJudge(), bank, checkpointer })

const SSE_HEADERS = { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' } as const

function firstInterrupt(snap: unknown): { value: unknown } | undefined {
  const tasks = (snap as { tasks?: Array<{ interrupts?: Array<{ value: unknown }> }> }).tasks ?? []
  for (const t of tasks) {
    const i = t.interrupts?.[0]
    if (i) return i
  }
  return undefined
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

function sse(res: http.ServerResponse) {
  return (frame: Record<string, unknown>) => res.write(`data: ${JSON.stringify(frame)}\n\n`)
}

/** 陪练：POST /api/practice {sessionId, text?} —— 无 text=开新场或重连补发；有 text=作答 resume */
async function handlePractice(req: http.IncomingMessage, res: http.ServerResponse) {
  const body = await readBody(req)
  const sessionId = String(body.sessionId ?? '')
  if (!sessionId) {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'sessionId 必传' }))
    return
  }
  const cfg = { configurable: { thread_id: `practice:${sessionId}` } }
  const text = typeof body.text === 'string' && body.text.trim() ? body.text.trim() : undefined

  res.writeHead(200, SSE_HEADERS)
  const send = sse(res)
  const t0 = Date.now()

  // 重连（无作答）且图正挂起：不推进，只补发题面
  const snap0 = await practice.getState(cfg)
  const paused = firstInterrupt(snap0)
  if (text === undefined && paused) {
    send({ type: 'question', ...(paused.value as object) })
    send({ type: 'done', ms: Date.now() - t0, note: 'reconnect' })
    res.end()
    return
  }

  const input = text === undefined ? { sessionId } : new Command({ resume: text })
  try {
    const stream = await practice.stream(input as never, { ...cfg, streamMode: 'custom' })
    for await (const payload of stream) {
      send({ type: 'custom', ...((payload ?? {}) as object) })
    }
    const snap = await practice.getState(cfg)
    const intr = firstInterrupt(snap)
    if (intr) send({ type: 'question', ...(intr.value as object) })
    else send({ type: 'done', ms: Date.now() - t0 })
  } catch (e) {
    send({ type: 'done', ms: Date.now() - t0, error: String(e) })
  }
  res.end()
}

const server = http.createServer(async (req, res) => {
  const url = req.url ?? '/'
  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(fs.readFileSync(path.join(here, 'web', 'index.html')))
    return
  }
  if (req.method === 'GET' && url === '/api/bank') {
    const bySource = new Map<string, number>()
    for (const q of bank) bySource.set(q.source, (bySource.get(q.source) ?? 0) + 1)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ total: bank.length, bySource: Object.fromEntries(bySource) }))
    return
  }
  if (req.method === 'POST' && url === '/api/practice') return handlePractice(req, res)
  if (req.method === 'POST' && (url === '/api/train' || url === '/api/resume')) {
    const which = url === '/api/train' ? TRAIN_STATUS : RESUME_STATUS
    res.writeHead(200, SSE_HEADERS)
    sse(res)({ type: 'done', note: which })
    res.end()
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found' }))
})

server.listen(env.port, () => {
  console.log(`[jobprep] AI 面试备战台 → http://localhost:${env.port}（Ctrl+C 停）`)
})
