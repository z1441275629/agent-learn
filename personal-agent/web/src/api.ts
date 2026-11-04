// 与 Node 服务通信的唯一入口（组件不直接碰 fetch，网络形状只在这里维护）

import type {
  ChatChunk,
  ChatRequest,
  MemoryItem,
  ModelsPayload,
  OcrRequest,
  OcrResponse,
  SessionDetail,
  SessionSummary,
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

/**
 * POST /api/chat，按 SSE 增量回调。
 * 服务端帧：{type:'delta',text} → {type:'done',text,usage,...}；出错为 {type:'error',error}。
 * 用 fetch reader 而不是 EventSource：EventSource 不能带 POST body。
 */
export async function streamChat(
  body: ChatRequest,
  onChunk: (chunk: ChatChunk) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok || !res.body) throw new Error(await readError(res))

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      const line = raw.split('\n').find((l) => l.startsWith('data: '))
      if (!line) continue
      const chunk = JSON.parse(line.slice(6)) as ChatChunk
      if (chunk.type === 'error') throw new Error(chunk.error ?? '模型出错')
      onChunk(chunk)
    }
  }
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

export async function clearMemories(): Promise<void> {
  const res = await fetch('/api/memories', { method: 'DELETE' })
  if (!res.ok) throw new Error(await readError(res))
}
