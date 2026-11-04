// PCM16 WAV 编码（纯函数，探针覆盖）——大模型转写录音用的格式底座。
//
// 为什么不用 MediaRecorder 直传（踩过）：Chrome 录出来是 audio/webm;codecs=opus，
// GLM-ASR 端点直接 400「不支持当前文件格式」——「OpenAI 兼容」说的是协议形状，
// 不是文件格式；wav/PCM16 才是转写端点的最大公约数。所以浏览器侧自己采集 PCM
// 再手写 WAV 头，零依赖也不猜上游白名单。

/** Float32 采样块（-1..1）→ PCM16 WAV 文件字节（单声道小端，44 字节标准头） */
export function encodeWav(chunks: Float32Array[], sampleRate: number): Blob {
  const frames = chunks.reduce((n, c) => n + c.length, 0)
  const bytesPerSample = 2
  const dataBytes = frames * bytesPerSample
  const buf = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buf)

  // RIFF 头：chunk descriptor 12 字节
  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true) // RIFF 块大小 = 文件大小 - 8
  writeAscii(view, 8, 'WAVE')

  // fmt 子块：PCM、单声道、16bit
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // fmt 块大小（PCM 固定 16）
  view.setUint16(20, 1, true) // 格式 = PCM
  view.setUint16(22, 1, true) // 声道数
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * bytesPerSample, true) // 字节率 = 采样率 × 块对齐
  view.setUint16(32, bytesPerSample, true) // 块对齐 = 声道 × 位深/8
  view.setUint16(34, 16, true) // 位深

  // data 子块：逐样本 clamp 到 [-1,1] 再放大到 int16
  writeAscii(view, 36, 'data')
  view.setUint32(40, dataBytes, true)
  let off = 44
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++) {
      const s = Math.max(-1, Math.min(1, c[i]))
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true)
      off += 2
    }
  }
  return new Blob([buf], { type: 'audio/wav' })
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
}
