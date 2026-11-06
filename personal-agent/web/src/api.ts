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
