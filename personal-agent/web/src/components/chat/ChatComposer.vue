<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { PendingAttachment } from '../../types'
import { toast } from '../../utils/toast'
import AttachmentChip from './AttachmentChip.vue'

const props = defineProps<{
  pending: PendingAttachment[]
  streaming: boolean
  /** 当前标签页是否可见——两个面板同时挂载，粘贴事件要按可见性分流 */
  active: boolean
}>()

const emit = defineEmits<{
  send: [text: string]
  'add-images': [files: File[]]
  'add-docs': [files: File[]]
  remove: [id: number]
}>()

const draft = ref('')
const textarea = ref<HTMLTextAreaElement | null>(null)
const imageInput = ref<HTMLInputElement | null>(null)
const docInput = ref<HTMLInputElement | null>(null)

function resize(): void {
  const el = textarea.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 180) + 'px'
}

function submit(): void {
  if (props.streaming) return
  const text = draft.value.trim()
  if (!text && props.pending.length === 0) return
  emit('send', text)
  draft.value = ''
  resize()
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    submit()
  }
}

function pickImages(event: Event): void {
  const input = event.target as HTMLInputElement
  emit('add-images', [...(input.files ?? [])])
  input.value = ''
}

function pickDocs(event: Event): void {
  const input = event.target as HTMLInputElement
  emit('add-docs', [...(input.files ?? [])])
  input.value = ''
}

function onPaste(e: ClipboardEvent): void {
  if (!props.active) return
  const files: File[] = []
  for (const item of e.clipboardData?.items ?? []) {
    if (!item.type.startsWith('image/')) continue
    const file = item.getAsFile()
    if (file) files.push(file)
  }
  if (files.length === 0) return
  e.preventDefault()
  emit('add-images', files)
  toast(`已添加 ${files.length} 张图片`)
}

onMounted(() => document.addEventListener('paste', onPaste))
onBeforeUnmount(() => document.removeEventListener('paste', onPaste))
</script>

<template>
  <footer class="composer">
    <div v-if="pending.length" class="pending">
      <AttachmentChip
        v-for="attachment in pending"
        :key="attachment.id"
        :attachment="attachment"
        @remove="emit('remove', attachment.id)"
      />
    </div>
    <div class="input-row">
      <textarea
        ref="textarea"
        v-model="draft"
        rows="1"
        placeholder="输入消息，Enter 发送，Shift+Enter 换行"
        @keydown="onKeydown"
        @input="resize"
      ></textarea>
      <button class="icon" title="上传图片" @click="imageInput?.click()">🖼</button>
      <button class="icon" title="上传文本附件" @click="docInput?.click()">📎</button>
      <button class="icon" title="语音输入（下一版接入）" @click="toast('语音输入下一版接入')">🎤</button>
      <button class="primary" :disabled="streaming" @click="submit">发送</button>
    </div>
    <input ref="imageInput" type="file" accept="image/*" multiple hidden @change="pickImages" />
    <input
      ref="docInput"
      type="file"
      accept=".txt,.md,.json,.csv,.log,.ts,.js,.py,.html,.css,.yaml,.yml"
      multiple
      hidden
      @change="pickDocs"
    />
    <div class="hint">图片发送给视觉模型；文本附件读入正文（单文件 ≤100KB）。语音输入下一版接入。</div>
  </footer>
</template>

<style scoped>
.composer {
  border-top: 1px solid var(--line);
  background: #fff;
  padding: 10px 18px 12px;
}

.pending {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
}

.input-row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}

textarea {
  flex: 1;
  resize: none;
  max-height: 180px;
  min-height: 40px;
  padding: 9px 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  font: inherit;
  font-size: 14px;
  line-height: 1.5;
  background: #fafbfc;
}

textarea:focus {
  outline: 2px solid var(--accent-soft);
  border-color: var(--accent);
}

.icon {
  width: 38px;
  height: 38px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: #fff;
  cursor: pointer;
  font-size: 16px;
}

.primary {
  border: 1px solid var(--accent);
  background: var(--accent);
  color: #fff;
  border-radius: 10px;
  padding: 0 18px;
  height: 38px;
  font: inherit;
  font-size: 14px;
  cursor: pointer;
}

.primary:disabled {
  opacity: 0.5;
  cursor: default;
}

.hint {
  margin-top: 6px;
  color: #9ca3af;
  font-size: 12px;
}
</style>
