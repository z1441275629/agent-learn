// 语音输入（浏览器原生 Web Speech API）的纯逻辑部分——不带浏览器依赖，探针可直接测
//
// 为什么用浏览器原生而不是服务端 ASR：个人工具零成本零配置（Chrome/Edge 自带语音服务，
// 走浏览器厂商通道）；127.0.0.1 是 secure context，麦克风权限可用。代价是浏览器依赖
// （Firefox 无此 API）——不支持就藏按钮，不硬撑。以后要多浏览器/离线再接服务端 ASR，
// 只换 useVoiceInput 的实现，这里的纯函数照用。

/**
 * 浏览器 SpeechRecognitionResult 的真实形状（照 DOM 规范，不是想象）：
 * 索引访问拿到的是 SpeechRecognitionAlternative 对象，文本在 .transcript 里——
 * 把 [0] 当字符串用会拼出「[object SpeechRecognitionAlternative]」（实测踩过）
 */
export interface VoiceResultItem {
  isFinal: boolean
  length: number
  [index: number]: { transcript: string; confidence?: number }
}

/**
 * 从一次 onresult 事件的 results（累积列表，含历史段）重建全文。
 * 每次全量重算而不是增量拼 resultIndex 之后——段会从 interim 变 final，重建才不会重复/丢段。
 */
export function mergeVoiceResults(results: Iterable<VoiceResultItem>): { finalText: string; interimText: string } {
  let finalText = ''
  let interimText = ''
  for (const r of results) {
    // 只取最优候选 [0]：其余是备选，拼进去等于把识别噪音写进草稿
    const text = r[0]?.transcript ?? ''
    if (r.isFinal) finalText += text
    else interimText += text
  }
  return { finalText, interimText }
}

/** 当前浏览器有没有原生 SpeechRecognition（Chrome/Edge 有；Firefox 没有） */
export function speechRecognitionSupported(): boolean {
  const w = window as any
  return !!(w.SpeechRecognition ?? w.webkitSpeechRecognition)
}

/** onerror 的 error 码 → 给用户看的话。'' = 静默（aborted 是正常停止路径） */
export function voiceErrorMessage(err: { error?: string }): string {
  switch (err?.error) {
    case 'not-allowed':
    case 'service-not-allowed':
      return '麦克风权限被拒——地址栏锁图标里允许麦克风后重试'
    case 'no-speech':
      return '没听到声音，再试一次'
    case 'audio-capture':
      return '没找到麦克风设备'
    case 'network':
      return '语音识别需要网络（浏览器语音服务）——检查网络后重试'
    case 'aborted':
      return ''
    default:
      return `语音识别出错：${err?.error ?? '未知'}`
  }
}
