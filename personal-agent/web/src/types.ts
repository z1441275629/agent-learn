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

/** 一次工具调用的痕迹（展示用；args/result 都是字符串原文） */
export interface ToolTraceInfo {
  name: string
  args: string
  result: string
  ms: number
}

/** 写入类工具的确认卡：outcome 为空 = 等人点允许/拒绝 */
export interface ConfirmCard {
  confirmId: string
  name: string
  args: string
  outcome?: 'approved' | 'denied' | 'timeout'
}

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
  /** 这条回答用过的工具（get_time / search_kb …） */
  tools?: ToolTraceInfo[]
  /** 这条回答里出现过的写入工具确认卡（界面即时交互用，审计以 tools 痕迹为准） */
  confirms?: ConfirmCard[]
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

/** 知识库文档（上传后切块索引，对话时 BM25 检索注入） */
export interface KbDoc {
  id: string
  name: string
  createdAt: string
  chunkCount: number
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
  /** false = 本轮不做知识库检索（默认做；工具开启时检索交给模型自主调用） */
  kbSearch: boolean
  /** false = 本轮禁用工具调用（默认开） */
  tools: boolean
}

export interface ChatChunk {
  type: 'session' | 'delta' | 'tool' | 'confirm' | 'done' | 'error'
  sessionId?: string
  title?: string
  text?: string
  usage?: ChatUsage
  model?: string
  elapsedMs?: number
  error?: string
  /** type:'tool' 时的一次工具调用；type:'done' 时是全量 trace */
  tools?: ToolTraceInfo[]
  /** type:'tool' 时的单条字段 */
  name?: string
  args?: string
  result?: string
  ms?: number
  /** type:'confirm'：有 outcome = 卡片定格；无 = 新的确认请求 */
  confirmId?: string
  outcome?: 'approved' | 'denied' | 'timeout'
}
