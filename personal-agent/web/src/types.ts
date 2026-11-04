// 前后端共用的数据形状（以 Node 服务端为准，这里只做前端侧的镜像）

export interface ModelEntry {
  id: string
  label: string
  model: string
  vision: boolean
}

export interface ModelsPayload {
  models: ModelEntry[]
  defaultModelId: string
  thinkingLevels: string[]
}

/** 服务商原始 usage：prompt/completion/total + cached_tokens/reasoning_tokens 等明细，形状随平台而异 */
export type ChatUsage = any

/** 服务端会话里的消息（图片已是可访问的 URL，不再是 base64） */
export interface DisplayMessage {
  id: number
  role: 'user' | 'assistant'
  content: string
  images: { src: string; name: string }[]
  usage?: ChatUsage
  elapsedMs?: number
  model?: string
  /** 非空 = 这条没成功（服务端不会把它放进下一轮上下文） */
  error?: string
  /** 用户点停止/断开时保存的半截回答 */
  interrupted?: boolean
  /** 仅前端：正在流式接收 */
  streaming?: boolean
}

export interface SessionSummary {
  id: string
  title: string
  updatedAt: string
  messageCount: number
}

/** 跨会话长期记忆（服务端抽取落盘，用户可查看/删除） */
export interface MemoryItem {
  id: string
  text: string
  createdAt: string
  updatedAt: string
}

export interface SessionDetail {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  modelId?: string
  thinking?: string
  messages: DisplayMessage[]
}

export type PendingAttachment =
  | { id: number; kind: 'image'; name: string; dataUrl: string }
  | { id: number; kind: 'text'; name: string; text: string }

export interface Bbox {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface OcrLine {
  id: number
  text: string
  bbox?: Bbox
  confidence?: number
}

export interface OcrResult {
  engine: 'local' | 'ai'
  text: string
  lines: OcrLine[]
  confidence?: number
  elapsedMs: number
  usage?: ChatUsage
}

export interface OcrResponse extends OcrResult {
  translations: { id: number; zh: string }[]
  translateError?: string
  translateUsage?: ChatUsage
}

export interface OcrRequest {
  image: string
  engine: 'local' | 'ai'
  translate: boolean
}

/** 客户端只发「新消息」；历史在服务端账本里 */
export interface ChatRequest {
  sessionId: string | null
  message: {
    text: string
    images: { dataUrl: string; name: string }[]
  }
  modelId: string
  thinking: string
  imageElision: boolean
}

export interface ChatChunk {
  type: 'session' | 'delta' | 'done' | 'error'
  sessionId?: string
  title?: string
  text?: string
  usage?: ChatUsage
  model?: string
  elapsedMs?: number
  error?: string
}
