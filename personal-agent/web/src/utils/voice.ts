// 语音输入（浏览器原生 Web Speech API）的纯逻辑部分——不带浏览器依赖，探针可直接测
//
// 为什么用浏览器原生而不是服务端 ASR：个人工具零成本零配置（Chrome/Edge 自带语音服务，
// 走浏览器厂商通道）；127.0.0.1 是 secure context，麦克风权限可用。代价是浏览器依赖
// （Firefox 无此 API）——不支持就藏按钮，不硬撑。以后要多浏览器/离线再接服务端 ASR，
// 只换 useVoiceInput 的实现，这里的纯函数照用。

/** 浏览器 SpeechRecognitionResult 的最小形状（类数组：[0] 是最优候选） */
export interface VoiceResultItem {
  isFinal: boolean
  length: number
  [index: number]: string
}

/**
 * 从一次 onresult 事件的 results（累积列表，含历史段）重建全文。
 * 每次全量重算而不是增量拼 resultIndex 之后——段会从 interim 变 final，重建才不会重复/丢段。
 */
export function mergeVoiceResults(results: Iterable<VoiceResultItem>): { finalText: string; interimText: string } {
  let finalText = ''
  let interimText = ''
  for (const r of results) {
    const text = r[0] ?? '' // 只取最优候选；其余候选是备选，拼进去等于把识别噪音写进草稿
    if (r.isFinal) finalText += text
    else interimText += text
  }
  return { finalText, interimText }
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
