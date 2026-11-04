// 大模型转写的浏览器侧：Web Audio 采 PCM → 停止时手写 WAV → 上传 /api/asr → 文本追加进草稿
//
// 为什么不用 MediaRecorder（真机踩过）：Chrome 只肯录 audio/webm;codecs=opus，GLM-ASR
// 端点 400「不支持当前文件格式」——协议 OpenAI 兼容 ≠ 文件格式兼容。浏览器自己采 PCM16
// 编 WAV（utils/wav.ts），格式掌握在自己手里，Chrome/Firefox/Safari 通吃。
//
// 与浏览器原生 SR 的差别全在时序：这里没有 interim——录音中只有红点，文本在「停止后」
// 一次性到（上传 + 转写约 1~2s）。状态机 idle → recording → transcribing → idle。
//
// Web Audio 的坑：
//   - 采样率在 AudioContext 构造时指定（16k 够语音识别，体积也小）；浏览器会自己重采样
//   - AudioWorklet 要独立模块文件——Blob URL 动态注入，不往构建产物里塞文件
//   - worklet 节点要连到目的地才被拉动：过零增益节点，防止麦克风回放外放
//   - getUserMedia 的 stream 必须逐 track 关掉，否则麦克风常亮

import { onBeforeUnmount, ref, type Ref } from 'vue'
import { transcribeAudio } from '../api'
import { toast } from '../utils/toast'
import { encodeWav } from '../utils/wav'

export type MicState = 'idle' | 'recording' | 'transcribing'

const MAX_RECORD_MS = 60_000
const SAMPLE_RATE = 16_000

// worklet 源码（在音频线程跑，postMessage 回主线程——传输 copy 避免线程间共享缓冲）
const RECORDER_WORKLET = `
class PcmTap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0]?.[0]
    if (ch) this.port.postMessage(ch.slice(0))
    return true
  }
}
registerProcessor('pcm-tap', PcmTap)
`

export function useMicRecorder(draft: Ref<string>) {
  const state = ref<MicState>('idle')

  let audioCtx: AudioContext | null = null
  let stream: MediaStream | null = null
  let workletUrl: string | null = null
  let chunks: Float32Array[] = []
  let base = ''
  let maxTimer: ReturnType<typeof setTimeout> | undefined

  function cleanupStream(): void {
    stream?.getTracks().forEach((t) => t.stop())
    stream = null
    void audioCtx?.close().catch(() => {})
    audioCtx = null
    if (workletUrl) {
      URL.revokeObjectURL(workletUrl)
      workletUrl = null
    }
  }

  async function start(): Promise<void> {
    if (state.value !== 'idle') return
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (e: any) {
      toast(
        e?.name === 'NotAllowedError'
          ? '麦克风权限被拒——地址栏锁图标里允许麦克风后重试'
          : '麦克风不可用：' + (e?.message ?? e),
      )
      cleanupStream()
      return
    }
    try {
      audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE })
      workletUrl = URL.createObjectURL(new Blob([RECORDER_WORKLET], { type: 'text/javascript' }))
      await audioCtx.audioWorklet.addModule(workletUrl)
      const source = audioCtx.createMediaStreamSource(stream)
      const tap = new AudioWorkletNode(audioCtx, 'pcm-tap')
      tap.port.onmessage = (e) => chunks.push(new Float32Array(e.data))
      const mute = audioCtx.createGain()
      mute.gain.value = 0 // 只采不播：worklet 要连到 destination 才跑，过零增益防回放
      source.connect(tap)
      tap.connect(mute)
      mute.connect(audioCtx.destination)
    } catch (e: any) {
      toast('录音启动失败：' + (e?.message ?? e))
      cleanupStream()
      return
    }
    base = draft.value.trim() ? draft.value.trimEnd() + '\n' : ''
    chunks = []
    state.value = 'recording'
    maxTimer = setTimeout(() => {
      if (state.value === 'recording') stop() // 忘关麦：60s 自动停并照常转写
    }, MAX_RECORD_MS)
  }

  function stop(): void {
    if (state.value !== 'recording' || !audioCtx) return
    clearTimeout(maxTimer)
    const sampleRate = audioCtx.sampleRate
    const captured = chunks
    cleanupStream()
    const blob = encodeWav(captured, sampleRate)
    if (blob.size <= 44) {
      state.value = 'idle'
      toast('没录到声音')
      return
    }
    state.value = 'transcribing'
    void transcribeAudio(blob)
      .then((r) => {
        if (r.text) {
          draft.value = base + r.text // 与浏览器引擎同一拼接语义：已有草稿则另起一行
        } else {
          toast('没识别到内容（可再试一次或换浏览器引擎）')
        }
      })
      .catch((e: any) => toast('转写失败：' + (e?.message ?? e)))
      .finally(() => {
        state.value = 'idle'
      })
  }

  function toggle(): void {
    if (state.value === 'recording') stop()
    else if (state.value === 'idle') void start()
    // transcribing 中点按：不打断上传，等结果（按钮此时显示 ⏳ 禁用态）
  }

  onBeforeUnmount(() => {
    clearTimeout(maxTimer)
    cleanupStream()
  })

  return { state, toggle }
}
