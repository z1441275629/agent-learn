// 语音输入状态机：开始/停止录音，识别文本实时写进 composer 的草稿 ref
//
// 时序要点（都是实测浏览器行为）：
//   - onresult 的 results 是「累积列表」：interim 段会在后续事件里变成 final——
//     每次全量重建（mergeVoiceResults），增量拼会重复
//   - onend 在 stop() 后异步到：界面状态先靠本地翻，文本定格等 onend 收尾；
//     防御性 500ms 兜底防 onend 不来卡死状态
//   - continuous=true 长听不停：60s 上限自动停，别让忘关的麦克风一直收音

import { onBeforeUnmount, ref, type Ref } from 'vue'
import { mergeVoiceResults, voiceErrorMessage, type VoiceResultItem } from '../utils/voice'
import { toast } from '../utils/toast'

type SpeechRecognitionLike = {
  lang: string
  continuous: boolean
  interimResults: boolean
  start(): void
  stop(): void
  onresult: ((e: { results: Iterable<VoiceResultItem> }) => void) | null
  onerror: ((e: { error?: string }) => void) | null
  onend: (() => void) | null
}

function getSpeechRecognition(): (new () => SpeechRecognitionLike) | null {
  const w = window as any
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

const MAX_LISTEN_MS = 60_000

export function useVoiceInput(draft: Ref<string>) {
  const supported = !!getSpeechRecognition()
  const listening = ref(false)

  let rec: SpeechRecognitionLike | null = null
  let base = '' // 开始录音时的草稿快照（语音文本接在它后面）
  let finalText = ''
  let interimText = ''
  let maxTimer: ReturnType<typeof setTimeout> | undefined
  let endGuard: ReturnType<typeof setTimeout> | undefined

  function render(): void {
    draft.value = base + finalText + interimText
  }

  function finish(): void {
    listening.value = false
    clearTimeout(maxTimer)
    clearTimeout(endGuard)
    interimText = ''
    render() // 定格：interim 撤掉，final 留在草稿里
    rec = null
  }

  function stop(): void {
    if (!rec) {
      finish()
      return
    }
    try {
      rec.stop() // 触发 onend（异步）；final 已在草稿里，stop 只是收尾
    } catch {
      // 已停过——走 onend 兜底
    }
    // onend 不来的兜底：500ms 后强制复位（别让状态卡在「录音中」）
    clearTimeout(endGuard)
    endGuard = setTimeout(finish, 500)
  }

  function start(): void {
    if (listening.value) return
    const SR = getSpeechRecognition()
    if (!SR) {
      toast('当前浏览器不支持语音输入（需 Chrome/Edge）')
      return
    }
    const r = new SR()
    r.lang = 'zh-CN'
    r.continuous = true
    r.interimResults = true
    base = draft.value.trim() ? draft.value.trimEnd() + '\n' : ''
    finalText = ''
    interimText = ''
    r.onresult = (e) => {
      const merged = mergeVoiceResults(e.results)
      finalText = merged.finalText
      interimText = merged.interimText
      render()
    }
    r.onerror = (e) => {
      const msg = voiceErrorMessage(e)
      if (msg) toast(msg)
    }
    r.onend = () => finish()
    try {
      r.start()
    } catch (e: any) {
      toast('语音识别启动失败：' + (e?.message ?? e))
      return
    }
    rec = r
    listening.value = true
    maxTimer = setTimeout(() => {
      if (listening.value) stop() // 忘关麦：60s 自动停
    }, MAX_LISTEN_MS)
  }

  function toggle(): void {
    listening.value ? stop() : start()
  }

  /** 发送前定格：停录音并同步撤掉 interim（返回定格后的草稿，调用方直接取用） */
  function finalize(): string {
    if (listening.value) {
      stop()
      finish() // 立即定格不等 onend——发送用的文本马上就要
    }
    return draft.value
  }

  onBeforeUnmount(() => {
    if (rec) {
      try {
        rec.stop()
      } catch {
        // 组件都要没了，尽力而为
      }
    }
    clearTimeout(maxTimer)
    clearTimeout(endGuard)
  })

  return { supported, listening, toggle, finalize }
}
