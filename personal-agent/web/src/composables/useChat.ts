// 对话状态与流程（组件只负责渲染，逻辑都在这里，便于单独读/测）
//
// 状态全部模块级单例：路由化后 ChatPane 会被 keep-alive 复用/重挂，会话状态必须活过组件实例。
// 多会话并行流：messagesBySid 按会话缓存消息，streamingSessions 记录进行中会话——
// 流式回答时切走再切回，内容不丢；会话列表的转圈标记由 streamingSessions 驱动。
//
// 会话在服务端：客户端只发「新消息」，历史由 /api/sessions 的账本维护。

import { computed, reactive, ref } from 'vue'
import { confirmToolCall, fetchModels, getSession, listSessions, streamChat } from '../api'
import type { ConfirmCard, DisplayMessage, ModelEntry, PendingAttachment, SessionSummary } from '../types'
import { toast } from '../utils/toast'
import { speechRecognitionSupported } from '../utils/voice'

const MAX_DOC_BYTES = 100 * 1024
/** messagesBySid 的 LRU 上限：挤出最旧的非活跃、非流式会话，防长驻页面内存无界涨 */
const MESSAGES_CACHE_MAX = 10

let seq = 0
const nextId = () => ++seq

// ---------- 模块级单例状态（useChat() 每次返回同一份） ----------
const models = ref<ModelEntry[]>([])
const modelId = ref('')
const thinking = ref('off')
const elideImages = ref(true)
const kbSearch = ref(true)
const toolsOn = ref(true)
const voiceEngine = ref<'browser' | 'asr'>('browser')
const asrModel = ref<string | null>(null)

const sessions = ref<SessionSummary[]>([])
const activeSid = ref<string | null>(null)
/** 按会话缓存消息（null = 尚未落库的新对话）；活跃键的消息由 messages computed 暴露 */
const messagesBySid = reactive(new Map<string | null, DisplayMessage[]>())
/** 进行中的流式会话集合（仅真实 sid；会话列表转圈标记的事实源） */
const streamingSessions = reactive(new Set<string>())
/** 进行中流的本地句柄（controller + placeholder），键同 messagesBySid——null 键覆盖「session 帧未到」的空窗 */
const runs = new Map<string | null, { controller: AbortController; placeholder: DisplayMessage }>()
/** 缓存 LRU 访问序：命中/写入 touch 到尾部，挤出从头部找「非活跃且非流式」的键 */
const cacheOrder = ref<(string | null)[]>([])
const pending = ref<PendingAttachment[]>([])

const EMPTY: DisplayMessage[] = []
const messages = computed<DisplayMessage[]>(() => messagesBySid.get(activeSid.value) ?? EMPTY)
// runs（而非 streamingSessions）做判定：新会话的首条消息在 session 帧到达前 activeSid 还是 null，
// 此时输入框也要禁用/显示停止——runs 以 null 为键覆盖了这个空窗
const streaming = computed(() => runs.has(activeSid.value))

function touchCache(key: string | null): void {
  cacheOrder.value = cacheOrder.value.filter((k) => k !== key)
  cacheOrder.value.push(key)
}

function evictCache(): void {
  while (messagesBySid.size > MESSAGES_CACHE_MAX) {
    const victim = cacheOrder.value.find((k) => k !== activeSid.value && !(k && streamingSessions.has(k)))
    if (victim === undefined) break
    messagesBySid.delete(victim)
    cacheOrder.value = cacheOrder.value.filter((k) => k !== victim)
  }
}

async function loadModels(): Promise<void> {
  try {
    const payload = await fetchModels()
    models.value = payload.models
    const ids = new Set(payload.models.map((m) => m.id))
    if (!modelId.value || !ids.has(modelId.value)) {
      modelId.value = payload.defaultModelId || payload.models[0]?.id || 'main'
    }
    asrModel.value = payload.asrModel ?? null
    if (!speechRecognitionSupported() && payload.asrModel && voiceEngine.value === 'browser')
      voiceEngine.value = 'asr'
    if (!payload.asrModel && voiceEngine.value === 'asr') voiceEngine.value = 'browser'
  } catch (e: any) {
    toast('模型目录加载失败：' + (e?.message ?? e))
  }
}

async function refreshSessions(): Promise<void> {
  try {
    const payload = await listSessions()
    sessions.value = payload.sessions
  } catch (e: any) {
    toast('会话列表加载失败：' + (e?.message ?? e))
  }
}

async function openSession(id: string): Promise<void> {
  if (messagesBySid.has(id)) {
    activeSid.value = id
    touchCache(id)
    pending.value = []
    return
  }
  try {
    const detail = await getSession(id)
    messagesBySid.set(id, detail.messages.map((m) => ({ ...m })))
    activeSid.value = id
    touchCache(id)
    evictCache()
    if (detail.modelId && models.value.some((m) => m.id === detail.modelId)) {
      modelId.value = detail.modelId
    }
    if (detail.thinking) thinking.value = detail.thinking
    pending.value = []
  } catch (e: any) {
    toast('打开会话失败：' + (e?.message ?? e))
  }
}

function newChat(): void {
  activeSid.value = null
  pending.value = []
}

async function init(): Promise<void> {
  await loadModels()
  try {
    const payload = await listSessions()
    sessions.value = payload.sessions
    if (payload.sessions.length > 0) await openSession(payload.sessions[0].id)
  } catch (e: any) {
    toast('会话列表加载失败：' + (e?.message ?? e))
  }
}

function addImages(files: File[]): void {
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue
    const reader = new FileReader()
    reader.onload = () => {
      pending.value.push({
        id: nextId(),
        kind: 'image',
        name: file.name || '粘贴的图片',
        dataUrl: String(reader.result),
      })
    }
    reader.readAsDataURL(file)
  }
}

function addDocs(files: File[]): void {
  for (const file of files) {
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      toast('PDF 暂不支持，先转成图片或文本')
      continue
    }
    if (file.size > MAX_DOC_BYTES) {
      toast('「' + file.name + '」超过 100KB，先拆分')
      continue
    }
    const reader = new FileReader()
    reader.onload = () => {
      pending.value.push({ id: nextId(), kind: 'text', name: file.name, text: String(reader.result) })
    }
    reader.readAsText(file)
  }
}

function removePending(id: number): void {
  pending.value = pending.value.filter((p) => p.id !== id)
}

async function send(text: string): Promise<void> {
  // key 跟踪本轮消息归属：新对话是 null，session 帧到达后 rekey 成真实 sid
  let key: string | null = activeSid.value
  if (runs.has(key)) return
  const trimmed = text.trim()
  if (!trimmed && pending.value.length === 0) return

  const images = pending.value.filter((p): p is Extract<PendingAttachment, { kind: 'image' }> => p.kind === 'image')
  let content = trimmed
  for (const p of pending.value) {
    if (p.kind !== 'text') continue
    content += content ? '\n\n' : ''
    content += '附件 ' + p.name + '：\n```\n' + p.text + '\n```\n'
  }
  const sentImages = images.map((i) => ({ dataUrl: i.dataUrl, name: i.name }))

  const list = messagesBySid.get(key) ?? []
  if (!messagesBySid.has(key)) messagesBySid.set(key, list)
  list.push({
    id: nextId(),
    role: 'user',
    content,
    images: images.map((i) => ({ src: i.dataUrl, name: i.name })),
  })
  pending.value = []

  const placeholder = reactive<DisplayMessage>({
    id: nextId(),
    role: 'assistant',
    content: '',
    images: [],
    streaming: true,
  })
  list.push(placeholder)
  touchCache(key)
  evictCache()

  const controller = new AbortController()
  runs.set(key, { controller, placeholder })
  try {
    let acc = ''
    await streamChat(
      {
        sessionId: key,
        message: { text: content, images: sentImages },
        modelId: modelId.value,
        thinking: thinking.value,
        imageElision: elideImages.value,
        kbSearch: kbSearch.value,
        tools: toolsOn.value,
      },
      (chunk) => {
        if (chunk.type === 'session') {
          const sid = chunk.sessionId
          if (sid && sid !== key) {
            // rekey：null（新对话）→ 真实 sid，消息列表/运行句柄/缓存序跟着搬
            const prevList = messagesBySid.get(key)
            messagesBySid.delete(key)
            if (prevList) messagesBySid.set(sid, prevList)
            const run = runs.get(key)
            runs.delete(key)
            if (run) runs.set(sid, run)
            cacheOrder.value = cacheOrder.value.map((k) => (k === key ? sid : k))
            const wasActive = activeSid.value === key
            key = sid
            if (wasActive) activeSid.value = sid
            streamingSessions.add(sid)
            void refreshSessions()
          }
        } else if (chunk.type === 'delta') {
          acc += chunk.text ?? ''
          placeholder.content = acc
        } else if (chunk.type === 'tool') {
          placeholder.tools = [
            ...(placeholder.tools ?? []),
            { name: chunk.name ?? '', args: chunk.args ?? '', result: chunk.result ?? '', ms: chunk.ms ?? 0 },
          ]
        } else if (chunk.type === 'confirm') {
          if (chunk.outcome) {
            const card = placeholder.confirms?.find((c) => c.confirmId === chunk.confirmId)
            if (card) card.outcome = chunk.outcome
          } else {
            placeholder.confirms = [
              ...(placeholder.confirms ?? []),
              { confirmId: chunk.confirmId ?? '', name: chunk.name ?? '', args: chunk.args ?? '' },
            ]
          }
        } else if (chunk.type === 'done') {
          placeholder.content = chunk.text || acc
          placeholder.usage = chunk.usage
          placeholder.elapsedMs = chunk.elapsedMs
          placeholder.ttftMs = chunk.ttftMs
          placeholder.model = chunk.model
          if (chunk.tools?.length) placeholder.tools = chunk.tools
        }
      },
      controller.signal,
    )
    if (!placeholder.content) throw new Error('模型没有返回内容')
  } catch (e: any) {
    if (controller.signal.aborted) {
      if (placeholder.content) {
        placeholder.interrupted = true
      } else {
        const idx = list.indexOf(placeholder)
        if (idx >= 0) list.splice(idx, 1)
      }
    } else {
      placeholder.error = '发送失败：' + (e?.message ?? e)
    }
  } finally {
    placeholder.streaming = false
    runs.delete(key)
    if (key) streamingSessions.delete(key)
    void refreshSessions()
  }
}

function stop(): void {
  const run = runs.get(activeSid.value)
  run?.controller.abort()
}

async function answerConfirm(card: ConfirmCard, approve: boolean, always = false): Promise<void> {
  card.outcome = approve ? 'approved' : 'denied'
  try {
    await confirmToolCall(card.confirmId, approve, always)
  } catch (e: any) {
    toast('确认没送到：' + (e?.message ?? e))
    card.outcome = undefined
  }
}

const sessionId = activeSid

export function useChat() {
  return {
    models,
    modelId,
    thinking,
    elideImages,
    kbSearch,
    toolsOn,
    voiceEngine,
    asrModel,
    sessions,
    activeSid,
    sessionId,
    messagesBySid,
    streamingSessions,
    messages,
    pending,
    streaming,
    init,
    openSession,
    newChat,
    refreshSessions,
    addImages,
    addDocs,
    removePending,
    send,
    stop,
    answerConfirm,
  }
}
