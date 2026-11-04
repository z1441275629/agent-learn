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

export type TextPart = { type: 'text'; text: string }
export type ImagePart = { type: 'image'; dataUrl: string; name?: string }
export type ContentPart = TextPart | ImagePart

/** 发给 /api/chat 的消息（与 server chat.ts 的 ChatMessage 对齐） */
export interface ApiMessage {
  role: 'user' | 'assistant'
  content: string | ContentPart[]
}

/** 界面上的消息（比 API 多带展示字段） */
export interface DisplayMessage {
  id: number
  role: 'user' | 'assistant'
  content: string
  images: { dataUrl: string; name: string }[]
  usage?: ChatUsage
  elapsedMs?: number
  model?: string
  /** 非空 = 这条没成功，只展示错误、不进下一轮 history */
  error?: string
  streaming?: boolean
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

export interface ChatRequest {
  messages: ApiMessage[]
  modelId: string
  thinking: string
  imageElision: boolean
}

export interface ChatChunk {
  type: 'delta' | 'done' | 'error'
  text?: string
  usage?: ChatUsage
  model?: string
  elapsedMs?: number
  error?: string
}
