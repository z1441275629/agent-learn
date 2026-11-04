// 对话状态与流程（组件只负责渲染，逻辑都在这里，便于单独读/测）
//
// 关键规则：
//   ① history 只包含成功的消息——失败的气泡留在界面上给人看，但不进入下一轮上下文
//   ② 图片只随最近一条 user 消息发（省略由服务端 normalizeMessages 做，这里只负责传对形状）
//   ③ 流式增量更新的是 messages 里的同一个对象（通过 reactive 代理写入，才能触发重渲染）

import { reactive, ref } from 'vue'
import { fetchModels, streamChat } from '../api'
import type { ApiMessage, ContentPart, DisplayMessage, ModelEntry, PendingAttachment } from '../types'
import { toast } from '../utils/toast'

const MAX_DOC_BYTES = 100 * 1024

let seq = 0
const nextId = () => ++seq

export function useChat() {
  const models = ref<ModelEntry[]>([])
  const modelId = ref('')
  const thinking = ref('off')
  const elideImages = ref(true)

  const messages = ref<DisplayMessage[]>([])
  const pending = ref<PendingAttachment[]>([])
  const streaming = ref(false)

  async function loadModels(): Promise<void> {
    try {
      const payload = await fetchModels()
      models.value = payload.models
      modelId.value = payload.defaultModelId || payload.models[0]?.id || 'main'
    } catch (e: any) {
      toast('模型目录加载失败：' + (e?.message ?? e))
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

  /** 界面消息 → API 消息（跳过失败/仍在流式的 assistant 气泡） */
  function buildHistory(): ApiMessage[] {
    return messages.value
      .filter((m) => !m.error && !m.streaming)
      .map((m): ApiMessage => {
        if (m.role === 'assistant') return { role: 'assistant', content: m.content }
        if (m.images.length === 0) return { role: 'user', content: m.content }
        const parts: ContentPart[] = []
        if (m.content) parts.push({ type: 'text', text: m.content })
        for (const image of m.images) parts.push({ type: 'image', dataUrl: image.dataUrl, name: image.name })
        return { role: 'user', content: parts }
      })
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

    messages.value.push({
      id: nextId(),
      role: 'user',
      content,
      images: images.map((i) => ({ dataUrl: i.dataUrl, name: i.name })),
    })
    pending.value = []

    const history = buildHistory() // 必须在 push assistant 之前取：占位气泡不进上下文
    const placeholder = reactive<DisplayMessage>({
      id: nextId(),
      role: 'assistant',
      content: '',
      images: [],
      streaming: true,
    })
    messages.value.push(placeholder)

    streaming.value = true
    try {
      let acc = ''
      await streamChat(
        {
          messages: history,
          modelId: modelId.value,
          thinking: thinking.value,
          imageElision: elideImages.value,
        },
        (chunk) => {
          if (chunk.type === 'delta') {
            acc += chunk.text ?? ''
            placeholder.content = acc
          } else if (chunk.type === 'done') {
            placeholder.content = chunk.text || acc
            placeholder.usage = chunk.usage
            placeholder.elapsedMs = chunk.elapsedMs
            placeholder.model = chunk.model
          }
        },
      )
      if (!placeholder.content) throw new Error('模型没有返回内容')
    } catch (e: any) {
      placeholder.error = '发送失败：' + (e?.message ?? e)
    } finally {
      placeholder.streaming = false
      streaming.value = false
    }
  }

  function clearChat(): void {
    if (streaming.value) {
      toast('等当前回答结束')
      return
    }
    messages.value = []
    pending.value = []
  }

  return {
    models,
    modelId,
    thinking,
    elideImages,
    messages,
    pending,
    streaming,
    loadModels,
    addImages,
    addDocs,
    removePending,
    send,
    clearChat,
  }
}
