<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { PendingAttachment } from '../../types'
import { toast } from '../../utils/toast'
import { useVoiceInput } from '../../composables/useVoiceInput'
import { useMicRecorder } from '../../composables/useMicRecorder'
import AttachmentChip from './AttachmentChip.vue'

const props = defineProps<{
  pending: PendingAttachment[]
  streaming: boolean
  /** 当前标签页是否可见——两个面板同时挂载，粘贴事件要按可见性分流 */
  active: boolean
  /** 语音引擎：browser = 浏览器原生 SR（实时）；asr = MediaRecorder 整段 → /api/asr 大模型转写 */
  voiceEngine: 'browser' | 'asr'
  /** 大模型转写可用时的模型名（决定麦克风按钮在无原生 SR 的浏览器里是否仍可用） */
  asrModel: string | null
}>()

const emit = defineEmits<{
  send: [text: string]
  stop: []
  'add-images': [files: File[]]
  'add-docs': [files: File[]]
  remove: [id: number]
}>()

const draft = ref('')
const textarea = ref<HTMLTextAreaElement | null>(null)
const imageInput = ref<HTMLInputElement | null>(null)
const docInput = ref<HTMLInputElement | null>(null)

// 双引擎：浏览器原生识别（实时 interim）；大模型转写（录音→上传→整段出文本）
const { supported: voiceSupported, listening, toggle: toggleVoice, finalize: finalizeVoice } = useVoiceInput(draft)
const { state: micState, toggle: toggleMic } = useMicRecorder(draft)

const micActive = computed(() => (props.voiceEngine === 'browser' ? listening.value : micState.value === 'recording'))
const micBusy = computed(() => props.voiceEngine === 'asr' && micState.value === 'transcribing')
const micIcon = computed(() => (micBusy.value ? '⏳' : micActive.value ? '⏹' : '🎤'))
const micAvailable = computed(() => (props.voiceEngine === 'asr' ? !!props.asrModel : voiceSupported))

function onMic(): void {
  if (props.voiceEngine === 'browser') {
    if (!voiceSupported) {
      toast('当前浏览器不支持原生语音识别——切到「语音：大模型」引擎')
      return
    }
    toggleVoice()
  } else {
    toggleMic()
  }
}

/** 草稿只读：任一引擎在收音时，手打的内容会被下一次识别结果覆盖 */
const draftLocked = computed(() => micActive.value)

function resize(): void {
  const el = textarea.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 180) + 'px'
}

function submit(): void {
  if (props.streaming) return
  if (listening.value) finalizeVoice() // 边说边发：先定格（撤掉未定段的转写），再取文本
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
        :readonly="draftLocked"
        :placeholder="
          micBusy
            ? '转写中…（说完约 1~2 秒出结果）'
            : micActive
              ? voiceEngine === 'browser'
                ? '正在听你说…（点 ⏹ 或发送结束）'
                : '录音中…（点 ⏹ 结束并转写，60 秒自动停）'
              : '输入消息，Enter 发送，Shift+Enter 换行'
        "
        @keydown="onKeydown"
        @input="resize"
      ></textarea>
      <button class="icon" title="上传图片" @click="imageInput?.click()">🖼</button>
      <button class="icon" title="上传文本附件" @click="docInput?.click()">📎</button>
      <button
        v-if="micAvailable"
        class="icon mic"
        :class="{ rec: micActive }"
        :disabled="micBusy"
        :title="
          micBusy
            ? '正在上传转写…'
            : micActive
              ? '停止录音（60 秒自动停）'
              : voiceEngine === 'browser'
                ? '语音输入：说话实时转文字（浏览器识别）'
                : `语音输入：录音交大模型转写（${asrModel}，说完出结果）`
        "
        @click="onMic"
      >
        {{ micIcon }}
      </button>
      <button class="primary" :disabled="!streaming && micActive" @click="streaming ? emit('stop') : submit()">
        {{ streaming ? '停止' : '发送' }}
      </button>
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
    <div class="hint">
      图片发送给视觉模型；文本附件读入正文（单文件 ≤100KB）{{
        micAvailable ? '；🎤 说话转文字（引擎在工具栏切换）' : ''
      }}
    </div>
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

.icon.mic.rec {
  border-color: #e11d48;
  background: #e11d48;
  color: #fff;
  animation: mic-pulse 1.2s ease-in-out infinite;
}

@keyframes mic-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgb(225 29 72 / 35%);
  }
  50% {
    box-shadow: 0 0 0 6px rgb(225 29 72 / 0%);
  }
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
