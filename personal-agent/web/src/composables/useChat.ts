// 对话状态与流程（组件只负责渲染，逻辑都在这里，便于单独读/测）
//
// 会话现在在服务端：客户端只发「新消息」，历史由 /api/sessions 的账本维护。
//   - 刷新页面 / 重启服务后，最近的会话能恢复
//   - 点停止后，服务端把半截回答落盘，下一轮可以接着聊
//   - 失败的消息留在界面，但服务端构建上下文时会排除（规则在 chat.ts）

import { reactive, ref } from 'vue'
import { fetchModels, getSession, listSessions, streamChat } from '../api'
import type { DisplayMessage, ModelEntry, PendingAttachment, SessionSummary } from '../types'
import { toast } from '../utils/toast'

const MAX_DOC_BYTES = 100 * 1024

let seq = 0
const nextId = () => ++seq

export function useChat() {
  const models = ref<ModelEntry[]>([])
  const modelId = ref('')
  const thinking = ref('off')
  const elideImages = ref(true)
  const kbSearch = ref(true)

  const sessions = ref<SessionSummary[]>([])
  const sessionId = ref<string | null>(null)
  const messages = ref<DisplayMessage[]>([])
  const pending = ref<PendingAttachment[]>([])
  const streaming = ref(false)

  let controller: AbortController | null = null

  async function loadModels(): Promise<void> {
    try {
      const payload = await fetchModels()
      models.value = payload.models
      const ids = new Set(payload.models.map((m) => m.id))
      if (!modelId.value || !ids.has(modelId.value)) {
        modelId.value = payload.defaultModelId || payload.models[0]?.id || 'main'
      }
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
    if (streaming.value) {
      toast('等当前回答结束')
      return
    }
    try {
      const detail = await getSession(id)
      sessionId.value = detail.id
      messages.value = detail.messages.map((m) => ({ ...m }))
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
    if (streaming.value) {
      toast('等当前回答结束')
      return
    }
    sessionId.value = null
    messages.value = []
    pending.value = []
  }

  /** 启动：先模型目录，再会话列表；有历史就打开最近一条 */
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
        toast(`「${file.name}」超过 100KB，先拆分`)
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
    if (streaming.value) return
    const trimmed = text.trim()
    if (!trimmed && pending.value.length === 0) return

    const images = pending.value.filter((p): p is Extract<PendingAttachment, { kind: 'image' }> => p.kind === 'image')
    let content = trimmed
    for (const p of pending.value) {
      if (p.kind !== 'text') continue
      content += `${content ? '\n\n' : ''}附件 ${p.name}：\n\`\`\`\n${p.text}\n\`\`\``
    }
    const sentImages = images.map((i) => ({ dataUrl: i.dataUrl, name: i.name }))

    messages.value.push({
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
    messages.value.push(placeholder)

    streaming.value = true
    controller = new AbortController()
    try {
      let acc = ''
      await streamChat(
        {
          sessionId: sessionId.value,
          message: { text: content, images: sentImages },
          modelId: modelId.value,
          thinking: thinking.value,
          imageElision: elideImages.value,
          kbSearch: kbSearch.value,
        },
        (chunk) => {
          if (chunk.type === 'session') {
            sessionId.value = chunk.sessionId ?? sessionId.value
            void refreshSessions()
          } else if (chunk.type === 'delta') {
            acc += chunk.text ?? ''
            placeholder.content = acc
          } else if (chunk.type === 'done') {
            placeholder.content = chunk.text || acc
            placeholder.usage = chunk.usage
            placeholder.elapsedMs = chunk.elapsedMs
            placeholder.model = chunk.model
          }
        },
        controller.signal,
      )
      if (!placeholder.content) throw new Error('模型没有返回内容')
    } catch (e: any) {
      if (controller?.signal.aborted) {
        // 服务端已把半截回答落盘；本地只是标记一下
        if (placeholder.content) {
          placeholder.interrupted = true
        } else {
          messages.value = messages.value.filter((m) => m.id !== placeholder.id)
        }
      } else {
        placeholder.error = '发送失败：' + (e?.message ?? e)
      }
    } finally {
      placeholder.streaming = false
      streaming.value = false
      controller = null
      void refreshSessions()
    }
  }

  function stop(): void {
    controller?.abort()
  }

  return {
    models,
    modelId,
    thinking,
    elideImages,
    kbSearch,
    sessions,
    sessionId,
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
  }
}
