// 大模型转写的浏览器侧：MediaRecorder 录整段 → 停止 → 上传 /api/asr → 文本追加进草稿
//
// 与浏览器原生 SR 的差别全在时序：这里没有 interim——录音中只有红点，文本在「停止后」
// 一次性到（上传 + 转写约 1~2s）。状态机 idle → recording → transcribing → idle。
//
// MediaRecorder 的坑：
//   - mimeType 要挑浏览器支持的（Chromium: audio/webm;codecs=opus；Safari: audio/mp4），
//     isTypeSupported 探测后选定，mime 会随 blob 一起交给后端（dataURL 自带）
//   - stop() 后 onstop 才有完整 blob：chunks 在 ondataavailable 里攒，别在 stop 里取
//   - getUserMedia 的 stream 必须逐 track 关掉，否则麦克风常亮

import { onBeforeUnmount, ref, type Ref } from 'vue'
import { transcribeAudio } from '../api'
import { toast } from '../utils/toast'

export type MicState = 'idle' | 'recording' | 'transcribing'

const MAX_RECORD_MS = 60_000

function pickMimeType(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
  for (const t of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(t)) return t
  }
  return ''
}

export function useMicRecorder(draft: Ref<string>) {
  const state = ref<MicState>('idle')

  let recorder: MediaRecorder | null = null
  let stream: MediaStream | null = null
  let chunks: Blob[] = []
  let base = ''
  let maxTimer: ReturnType<typeof setTimeout> | undefined

  function cleanupStream(): void {
    stream?.getTracks().forEach((t) => t.stop())
    stream = null
    recorder = null
  }

  async function start(): Promise<void> {
    if (state.value !== 'idle') return
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (e: any) {
      toast(
        e?.name === 'NotAllowedError'
          ? '麦克风权限被拒——地址栏锁图标里允许后重试'
          : '麦克风不可用：' + (e?.message ?? e),
      )
      cleanupStream()
      return
    }
    const mimeType = pickMimeType()
    try {
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
    } catch (e: any) {
      toast('录音启动失败：' + (e?.message ?? e))
      cleanupStream()
      return
    }
    base = draft.value.trim() ? draft.value.trimEnd() + '\n' : ''
    chunks = []
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data)
    }
    recorder.onstop = async () => {
      const blob = new Blob(chunks, { type: recorder?.mimeType || 'audio/webm' })
      cleanupStream()
      if (blob.size === 0) {
        state.value = 'idle'
        toast('没录到声音')
        return
      }
      state.value = 'transcribing'
      try {
        const r = await transcribeAudio(blob)
        if (r.text) {
          draft.value = base + r.text // 与浏览器引擎同一拼接语义：已有草稿则另起一行
        } else {
          toast('没识别到内容（可再试一次或换浏览器引擎）')
        }
      } catch (e: any) {
        toast('转写失败：' + (e?.message ?? e))
      } finally {
        state.value = 'idle'
      }
    }
    recorder.start()
    state.value = 'recording'
    maxTimer = setTimeout(() => {
      if (state.value === 'recording') stop() // 忘关麦：60s 自动停并照常转写
    }, MAX_RECORD_MS)
  }

  function stop(): void {
    if (state.value !== 'recording' || !recorder) return
    clearTimeout(maxTimer)
    try {
      recorder.stop() // 完整 blob 在 onstop 里；状态切换也交给 onstop
    } catch {
      state.value = 'idle'
      cleanupStream()
    }
  }

  function toggle(): void {
    if (state.value === 'recording') stop()
    else if (state.value === 'idle') void start()
    // transcribing 中点按：不打断上传，等结果（按钮此时显示 ⏳ 禁用态）
  }

  onBeforeUnmount(() => {
    clearTimeout(maxTimer)
    try {
      recorder?.state === 'recording' && recorder.stop()
    } catch {
      // 尽力而为
    }
    cleanupStream()
  })

  return { state, toggle }
}
