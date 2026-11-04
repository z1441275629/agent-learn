// 产品核心：会话账本（历史会话 / 刷新恢复 / 停止后继续的地基）
//
// 设计取舍：
//   ① 一个会话 = 一个 JSON 文档 + 一个同名图片目录；图片二进制不塞 JSON（否则几 MB 的
//      截图会把档案撑成臃肿的 base64 垃圾，读写全慢）
//   ② 先写 .tmp 再 rename：原子写。写一半被杀，毁的是 tmp，旧档完好
//   ③ 会话 id / 文件名双重白名单校验：这些值来自 URL，必须挡住 ../ 穿越
//   ④ 存储根由构造参数注入（createSessionStore(dataDir)）——不写死 import.meta.dirname，
//      换目录只改配置，也方便以后单测用临时目录
//
// 这里是「存储」，不理解 LLM 消息语义；消息如何变成 API 形状在 personal-agent/chat.ts。

import fs from 'node:fs/promises'
import path from 'node:path'

export interface StoredImage {
  /** 相对会话图片目录的文件名（随机生成，不含用户输入） */
  file: string
  name: string
  mime: string
}

export interface StoredMessage {
  id: number
  role: 'user' | 'assistant'
  text: string
  images: StoredImage[]
  usage?: any
  model?: string
  elapsedMs?: number
  error?: string
  /** 用户点「停止」/断开连接时保存的半截回答 */
  interrupted?: boolean
  /** 本条回答产生的工具调用痕迹（展示用；重放上下文不喂给模型） */
  tools?: { name: string; args: string; result: string; ms: number }[]
  createdAt: string
}

export interface SessionDoc {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  modelId?: string
  thinking?: string
  /** 上下文压缩后的前情摘要（原文仍完整保存在 messages 里） */
  summary?: string
  /** 已被摘要覆盖的最后一条消息 id；请求只发送 id > summaryUntil 的原文 */
  summaryUntil?: number
  messages: StoredMessage[]
}

export interface SessionSummary {
  id: string
  title: string
  updatedAt: string
  messageCount: number
}

export interface NewMessage {
  role: 'user' | 'assistant'
  text: string
  images?: StoredImage[]
  usage?: any
  model?: string
  elapsedMs?: number
  error?: string
  interrupted?: boolean
  tools?: { name: string; args: string; result: string; ms: number }[]
}

export interface AppendOptions {
  /** 只对第一条 user 消息生效（之后的调用不会改标题） */
  title?: string
  modelId?: string
  thinking?: string
}

const ID_RE = /^[A-Za-z0-9_-]+$/
const FILE_RE = /^[A-Za-z0-9._-]+$/
const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}
const EXT_MIME: Record<string, string> = Object.fromEntries(Object.entries(MIME_EXT).map(([mime, ext]) => [ext, mime]))

/** dataURL → {mime, data}；只收 png/jpeg/webp/gif（不替用户解释任意 MIME） */
export function parseImageDataUrl(dataUrl: string): { mime: string; data: Buffer } | null {
  const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl.trim())
  if (!m) return null
  const data = Buffer.from(m[2], 'base64')
  if (data.length === 0) return null
  return { mime: m[1].toLowerCase(), data }
}

export function newSessionId(): string {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '_' + Math.random().toString(36).slice(2, 8)
}

export interface SessionStore {
  readonly sessionsDir: string
  list(): Promise<SessionSummary[]>
  create(title?: string): Promise<SessionDoc>
  load(id: string): Promise<SessionDoc | null>
  save(doc: SessionDoc): Promise<void>
  append(id: string, message: NewMessage, opts?: AppendOptions): Promise<SessionDoc>
  /** 落盘压缩摘要与截止点（原文不动——底账永远完整） */
  setSummary(id: string, summary: string, summaryUntil: number): Promise<void>
  saveImage(sessionId: string, dataUrl: string, name?: string): Promise<StoredImage>
  readImage(sessionId: string, file: string): Promise<{ mime: string; data: Buffer } | null>
  remove(id: string): Promise<void>
}

export function createSessionStore(dataDir: string): SessionStore {
  const sessionsDir = path.join(dataDir, 'sessions')

  const fileFor = (id: string) => path.join(sessionsDir, `${id}.json`)
  const imagesDirFor = (id: string) => path.join(sessionsDir, id, 'images')

  function assertId(id: string): void {
    if (!ID_RE.test(id)) throw Object.assign(new Error('非法会话 id'), { code: 400 })
  }

  async function load(id: string): Promise<SessionDoc | null> {
    if (!ID_RE.test(id)) return null
    try {
      const parsed = JSON.parse(await fs.readFile(fileFor(id), 'utf8')) as SessionDoc
      if (!parsed || !Array.isArray(parsed.messages) || parsed.id !== id) return null
      return parsed
    } catch {
      return null
    }
  }

  async function save(doc: SessionDoc): Promise<void> {
    assertId(doc.id)
    await fs.mkdir(sessionsDir, { recursive: true })
    const file = fileFor(doc.id)
    const tmp = file + '.tmp'
    await fs.writeFile(tmp, JSON.stringify(doc))
    await fs.rename(tmp, file) // 原子替换：崩溃最多丢当前这次写，不会留半截档
  }

  return {
    sessionsDir,

    async list() {
      let names: string[]
      try {
        names = await fs.readdir(sessionsDir)
      } catch {
        return []
      }
      const docs = await Promise.all(
        names.filter((n) => n.endsWith('.json')).map((n) => load(n.slice(0, -'.json'.length))),
      )
      return docs
        .filter((d): d is SessionDoc => !!d)
        .map((d) => ({
          id: d.id,
          title: d.title,
          updatedAt: d.updatedAt,
          messageCount: d.messages.length,
        }))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    },

    async create(title = '新对话') {
      const now = new Date().toISOString()
      const doc: SessionDoc = {
        id: newSessionId(),
        title,
        createdAt: now,
        updatedAt: now,
        messages: [],
      }
      await save(doc)
      return doc
    },

    load,
    save,

    async append(id, message, opts = {}) {
      const doc = await load(id)
      if (!doc) throw Object.assign(new Error('会话不存在'), { code: 404 })
      const nextId = doc.messages.reduce((max, m) => Math.max(max, m.id), 0) + 1
      doc.messages.push({
        id: nextId,
        role: message.role,
        text: message.text,
        images: message.images ?? [],
        usage: message.usage,
        model: message.model,
        elapsedMs: message.elapsedMs,
        error: message.error,
        interrupted: message.interrupted,
        tools: message.tools,
        createdAt: new Date().toISOString(),
      })
      // 标题只由第一条 user 消息决定；后续 checkpoint 不能把它改掉
      if (opts.title && doc.messages.filter((m) => m.role === 'user').length === 1) {
        doc.title = opts.title
      }
      if (opts.modelId) doc.modelId = opts.modelId
      if (opts.thinking) doc.thinking = opts.thinking
      doc.updatedAt = new Date().toISOString()
      await save(doc)
      return doc
    },

    async setSummary(id, summary, summaryUntil) {
      const doc = await load(id)
      if (!doc) throw Object.assign(new Error('会话不存在'), { code: 404 })
      doc.summary = summary
      doc.summaryUntil = summaryUntil
      doc.updatedAt = new Date().toISOString()
      await save(doc)
    },

    async saveImage(sessionId, dataUrl, name) {
      assertId(sessionId)
      const parsed = parseImageDataUrl(dataUrl)
      if (!parsed) throw Object.assign(new Error('图片必须是 png/jpeg/webp/gif 的 dataURL'), { code: 400 })
      const ext = MIME_EXT[parsed.mime]
      const file = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}.${ext}`
      const dir = imagesDirFor(sessionId)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, file), parsed.data)
      return {
        file,
        name: (name || '粘贴的图片').slice(0, 120),
        mime: parsed.mime,
      }
    },

    async readImage(sessionId, file) {
      if (!ID_RE.test(sessionId) || !FILE_RE.test(file)) return null
      const full = path.resolve(imagesDirFor(sessionId), file)
      const base = path.resolve(imagesDirFor(sessionId)) + path.sep
      if (!full.startsWith(base)) return null
      const ext = path.extname(file).slice(1).toLowerCase()
      const mime = EXT_MIME[ext]
      if (!mime) return null
      try {
        return { mime, data: await fs.readFile(full) }
      } catch {
        return null
      }
    },

    async remove(id) {
      if (!ID_RE.test(id)) return
      await fs.rm(fileFor(id), { force: true })
      await fs.rm(imagesDirFor(id), { recursive: true, force: true })
    },
  }
}
