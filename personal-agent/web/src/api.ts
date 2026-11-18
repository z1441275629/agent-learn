// 与 Node 服务通信的唯一入口（组件不直接碰 fetch，网络形状只在这里维护）

import type {
  ChatChunk,
  ChatRequest,
  KbDoc,
  MemoryItem,
  ModelsPayload,
  OcrRequest,
  OcrResponse,
  SessionDetail,
  SessionSummary,
  SkillInfo,
} from './types'

async function readError(res: Response): Promise<string> {
  try {
    const j = await res.json()
    return j.error ?? `HTTP ${res.status}`
  } catch {
    return `HTTP ${res.status}`
  }
}

export async function fetchModels(): Promise<ModelsPayload> {
  const res = await fetch('/api/models')
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export async function listSessions(): Promise<{ sessions: SessionSummary[] }> {
  const res = await fetch('/api/sessions')
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

export async function getSession(id: string): Promise<SessionDetail> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`)
  if (!res.ok) throw new Error(await readError(res))
  const j = await res.json()
  return j.session as SessionDetail
}

// ---------- 流式对话：预流幂等重试 / 断线重连（快速+慢探针）/ idle 对齐 ----------

export type StreamStatus = "connecting" | "streaming" | "reconnecting" | "aligning"
export interface StreamHandlers {
  onChunk: (chunk: ChatChunk) => void
  onStatus: (status: StreamStatus) => void
}
export interface StreamResult {
  sessionId: string
  outcome: 'done' | 'aligned' | 'stopped'
}

/** 预流重试退避：只对连接层失败（一个字节都没收到）生效——服务端已受理的错误绝不重发 */
const PRE_STREAM_BACKOFF_MS = [500, 1000, 2000]
/** 断线后快速重连退避 */
const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000]
/** 快速重连穷尽后的慢探针间隔 */
const PROBE_INTERVAL_MS = 15000
/** 探针地平线：与默认 PA_GRACE_MS(90s) 对齐再留 30s；服务端改 PA_GRACE_MS 需同步这里 */
const PROBE_HORIZON_MS = 120000
/** 整梯（快速4次+慢探针120s）跑几轮仍断流才放弃对齐：续上又断的场景不死心，重走重连梯 */
const LADDER_PASSES = 3

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** requestId 生成：crypto.randomUUID 只在安全上下文（https/localhost）存在——
 * PA_HOST=0.0.0.0 的手机访问是 http，没有它；退化成时间戳+随机串（只做重放识别，够用） */
export function newRequestId(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return 'req-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
}

/** 可被「页面变可见/窗口聚焦」提前唤醒的 sleep：合盖唤醒后立即插一次探针 */
function sleepAware(ms: number): Promise<void> {
  return new Promise((resolve) => {
    let settle = () => {}
    const t = setTimeout(() => {
      cleanup()
      settle()
    }, ms)
    const onWake = () => {
      clearTimeout(t)
      cleanup()
      settle()
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') onWake()
    }
    function cleanup() {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onWake)
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onWake)
    settle = resolve
  })
}

/** SSE 帧解析：喂字节按空行切帧；id: 行记录续接位置，data: 行交回调 */
function createSseParser(onFrame: (id: number | null, data: string) => void) {
  let buf = ''
  return {
    feed(chunkText: string): void {
      buf += chunkText
      let idx: number
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        let id: number | null = null
        let data: string | null = null
        for (const line of raw.split('\n')) {
          if (line.startsWith('id: ')) id = Number.parseInt(line.slice(4), 10) || 0
          else if (line.startsWith('data: ')) data = line.slice(6)
        }
        if (data !== null) onFrame(id, data)
      }
    },
  }
}

/** 消费一条 SSE 响应到终帧/EOF。终帧决定返回值；无终帧 EOF = 断流；error 帧原样抛出 */
type ConsumeOutcome = "completed" | "dropped" | "idle" | "stopped"

export async function streamChat(body: ChatRequest, handlers: StreamHandlers, signal?: AbortSignal): Promise<StreamResult> {
  const req: ChatRequest = { ...body, requestId: body.requestId ?? newRequestId() }
  handlers.onStatus('connecting')
  let sid: string | null = body.sessionId ?? null
  let lastEventId = 0

  async function streamLoop(res: Response): Promise<ConsumeOutcome> {
    if (!res.ok || !res.body) throw new Error(await readError(res))
    handlers.onStatus('streaming')
    let doneFrame = false
    let stoppedFrame = false
    let idleFrame = false
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    const parser = createSseParser((id, data) => {
      if (id !== null) lastEventId = id
      const chunk = JSON.parse(data) as ChatChunk
      if (chunk.type === 'session' && chunk.sessionId) sid = chunk.sessionId
      if (chunk.type === 'done') doneFrame = true
      if (chunk.type === 'stopped') stoppedFrame = true
      if (chunk.type === 'idle') idleFrame = true
      if (chunk.type === 'error') throw new Error(chunk.error ?? '模型出错')
      handlers.onChunk(chunk)
    })
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      parser.feed(decoder.decode(value, { stream: true }))
    }
    if (doneFrame) return 'completed'
    if (stoppedFrame) return 'stopped'
    if (idleFrame) return 'idle'
    return 'dropped'
  }

  /** 断线续接：快速重连 4 次 → 慢探针到地平线，这算一整梯。中途再次断流不算终局——
   * 重走重连梯直到终帧/abort/梯数耗尽（耗尽=idle 走对齐，拉账本不丢内容） */
  async function attachLoop(): Promise<ConsumeOutcome> {
    if (!sid) return 'idle'
    handlers.onStatus('reconnecting')
    const url = () => `/api/chat/${encodeURIComponent(sid!)}/stream?lastEventId=${lastEventId}`
    /** 一次续接尝试：终帧原样上交；连接层失败/读到再断流都返回 null（继续重连） */
    async function attempt(): Promise<ConsumeOutcome | null> {
      if (signal?.aborted) return 'stopped'
      try {
        const out = await streamLoop(await fetch(url(), { signal }))
        return out === 'dropped' ? null : out
      } catch {
        return signal?.aborted ? 'stopped' : null
      }
    }
    for (let pass = 0; pass < LADDER_PASSES; pass++) {
      for (const ms of RECONNECT_BACKOFF_MS) {
        if (signal?.aborted) return 'stopped'
        await sleep(ms)
        const out = await attempt()
        if (out) return out
      }
      const deadline = Date.now() + PROBE_HORIZON_MS
      while (Date.now() < deadline) {
        await sleepAware(Math.min(PROBE_INTERVAL_MS, deadline - Date.now()))
        const out = await attempt()
        if (out) return out
      }
    }
    return 'idle'
  }

  // --- 发起段：POST 预流连接层失败幂等重试；JSON 响应 = 幂等命中（转续接/对齐） ---
  // 计划原文协议：只对「一个字节都没收到」的连接层失败重试；服务端返回任何 JSON/HTTP
  // 错误码都不重试直接展示——409（在跑）/404（深链失效）重发只会白传三遍 body 还晚 3.5s 报错
  let first: Response | null = null
  for (let attempt = 0; ; attempt++) {
    let r: Response
    try {
      r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
        signal,
      })
    } catch (e) {
      // 连接层失败（fetch 本身拒绝）才走幂等重试
      if (signal?.aborted) throw e
      if (attempt >= PRE_STREAM_BACKOFF_MS.length) throw e
      await sleep(PRE_STREAM_BACKOFF_MS[attempt])
      continue
    }
    if (!r.ok) throw new Error(await readError(r))
    const ct = r.headers.get('content-type') ?? ''
    if (ct.includes('application/json')) {
      // 幂等命中：服务端已在处理同一个 requestId
      const j = (await r.json()) as { sessionId?: string; done?: boolean }
      if (j.sessionId) sid = String(j.sessionId)
      if (j.done) {
        handlers.onStatus('aligning')
        return { sessionId: sid ?? '', outcome: 'aligned' }
      }
      first = null // 在跑：直接进续接循环
    } else {
      first = r
    }
    break
  }

  let out: ConsumeOutcome
  if (first) {
    out = await streamLoop(first)
    if (out === 'dropped') out = await attachLoop()
  } else {
    out = await attachLoop()
  }
  if (!sid) throw new Error('连接中断且会话未知——请重试')
  if (out === 'dropped' || out === 'idle') {
    // 续跑不可能或已结束：拉服务端账本对齐（半截回答/错误信息都已在账本）
    handlers.onStatus('aligning')
    return { sessionId: sid, outcome: 'aligned' }
  }
  return { sessionId: sid, outcome: out === 'completed' ? 'done' : 'stopped' }
}

/** 在跑会话清单（刷新后恢复列表「进行中」标记） */
export async function fetchRunningSessions(): Promise<string[]> {
  const res = await fetch('/api/chat/running')
  if (!res.ok) throw new Error(await readError(res))
  const j = await res.json()
  return (j.sessionIds ?? []) as string[]
}

/** 显式停止某会话的生成（服务端 abort+落盘；404 = 已结束） */
export async function stopSession(sid: string): Promise<void> {
  const res = await fetch(`/api/chat/${encodeURIComponent(sid)}/stop`, { method: 'POST' })
  if (!res.ok) throw new Error(await readError(res))
}


export async function runOcr(req: OcrRequest): Promise<OcrResponse> {
  const res = await fetch('/api/ocr' + (req.translate ? '' : '?translate=0'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: req.image, engine: req.engine }),
  })
  if (!res.ok) {
    const msg = await readError(res)
    throw new Error(msg + (res.status === 502 ? ' ——可切到「本地」引擎重试' : ''))
  }
  return res.json()
}

// ---------- 大模型语音转写（方式①：MediaRecorder 整段上传 → /api/asr → 文本） ----------

export interface AsrResult {
  text: string
  elapsedMs: number
  model: string
}

export async function transcribeAudio(audio: Blob): Promise<AsrResult> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('读音频失败'))
    reader.readAsDataURL(audio)
  })
  const res = await fetch('/api/asr', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio: dataUrl }),
  })
  if (!res.ok) throw new Error(await readError(res))
  return res.json()
}

// ---------- 长期记忆（查看/删除——它记了什么，用户得看得见、管得着） ----------

export async function listMemories(): Promise<MemoryItem[]> {
  const res = await fetch('/api/memories')
  if (!res.ok) throw new Error(await readError(res))
  const j = await res.json()
  return j.memories as MemoryItem[]
}

export async function deleteMemory(id: string): Promise<void> {
  const res = await fetch(`/api/memories/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(await readError(res))
}

/** 应答写入工具的确认卡（允许/拒绝；always = 本会话内此工具不再出卡）。404 = 已处理或已超时 */
export async function confirmToolCall(confirmId: string, approve: boolean, always = false): Promise<void> {
  const res = await fetch('/api/chat/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmId, approve, always }),
  })
  if (!res.ok) throw new Error(await readError(res))
}

export async function clearMemories(): Promise<void> {
  const res = await fetch('/api/memories', { method: 'DELETE' })
  if (!res.ok) throw new Error(await readError(res))
}

// ---------- 知识库（个人笔记：上传切块索引，对话时 BM25 检索注入） ----------

export async function listKb(): Promise<KbDoc[]> {
  const res = await fetch('/api/kb')
  if (!res.ok) throw new Error(await readError(res))
  const j = await res.json()
  return j.docs as KbDoc[]
}

export async function addKb(name: string, text: string): Promise<KbDoc> {
  const res = await fetch('/api/kb', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, text }),
  })
  if (!res.ok) throw new Error(await readError(res))
  const j = await res.json()
  return j.doc as KbDoc
}

export async function deleteKb(id: string): Promise<void> {
  const res = await fetch(`/api/kb/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(await readError(res))
}

// ---------- 技能（use_skill 加载执行在对话里；这里只列可用技能的索引） ----------

export async function listSkills(): Promise<SkillInfo[]> {
  const res = await fetch('/api/skills')
  if (!res.ok) throw new Error(await readError(res))
  const j = await res.json()
  return j.skills as SkillInfo[]
}
