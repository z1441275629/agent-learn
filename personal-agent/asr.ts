// 大模型语音转写（方式①：整段录音 → 后端 → OpenAI 兼容 /audio/transcriptions → 文本）
//
// 与浏览器原生 SR（方式②浏览器版）的对照：
//   - 浏览器 SR：实时 interim、免费，但依赖 Chromium 系 + 浏览器厂商语音服务（要联网）
//   - 本路径：任何浏览器可用（Firefox 也行）、模型可换（glm-asr / Whisper / 硅基 SenseVoice），
//     代价是说完才出结果（上传 + 转写约 1~2s）且按 duration 计费（分/分钟级）
// 端点三件套 PA_ASR_* 可整体换平台；缺省回落小档/embed 档的端点与 key（都在大模型平台）
//
// 流式 ASR（WebSocket 边说边出字，方式②服务端版）与原生语音多模态（音频直接进模型，
// 方式③）是后续层——接口形态完全不同（WS 状态机 / 多模态 content），不在本文件。

export interface AsrConfig {
  baseUrl: string
  apiKey: string
  model: string
}

/** 环境解析（纯函数，探针覆盖）：base/key 一样都没有 = 功能未配置，UI 藏引擎选项。
 *  回落顺序：备用档 > 小档 > embed 档——ASR 按时长计费，只能落按量端点；小档/embed 档
 *  常指向 coding 订阅端点（只挂聊天路由，/audio/* 是 404，实测踩过），备用档默认 bigmodel paas v4 */
export function resolveAsrConfig(env: Record<string, string | undefined>): AsrConfig | null {
  const baseUrl = (
    env.PA_ASR_BASE_URL ||
    env.LLM_BACKUP_BASE_URL ||
    env.LLM_LIGHT_BASE_URL ||
    env.LLM_EMBED_BASE_URL ||
    ''
  ).replace(/\/$/, '')
  const apiKey =
    env.PA_ASR_API_KEY ||
    env.LLM_BACKUP_API_KEY ||
    env.LLM_LIGHT_API_KEY ||
    env.LLM_EMBED_API_KEY ||
    env.LLM_API_KEY ||
    ''
  if (!baseUrl || !apiKey) return null
  return { baseUrl, apiKey, model: env.PA_ASR_MODEL || 'glm-asr' }
}

const AUDIO_MIME_BASES = new Set([
  'audio/webm',
  'audio/ogg',
  'audio/ogg/opus', // 部分 MediaRecorder 实现
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/aac',
  'audio/flac',
])
const MIME_EXT: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/ogg/opus': 'ogg',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
}
export const MAX_ASR_BYTES = 25 * 1024 * 1024 // 对齐主流转写 API 的文件上限

/** 入口校验（纯函数）：mime 基名（剥掉 ;codecs= 参数）在白名单内、有字节、不超限 */
export function validateAsrAudio(
  mime: string,
  bytes: number,
): { ok: true } | { ok: false; code: number; error: string } {
  const base = (mime || '').split(';')[0].trim().toLowerCase()
  if (!base || !AUDIO_MIME_BASES.has(base))
    return { ok: false, code: 400, error: `不支持的音频格式：${base || '（空）'}` }
  if (!MIME_EXT[base]) return { ok: false, code: 400, error: `格式 ${base} 没有对应的扩展名映射` }
  if (bytes <= 0) return { ok: false, code: 400, error: '音频内容为空' }
  if (bytes > MAX_ASR_BYTES) return { ok: false, code: 413, error: `音频太大（上限 25MB）` }
  return { ok: true }
}

/** 转写响应解析（纯函数）：吃 OpenAI 兼容形状 {text}，错误形状统一抛带信息 */
export function parseTranscription(json: any): string {
  if (typeof json?.text === 'string') return json.text.trim()
  if (typeof json?.error === 'string') throw new Error(json.error)
  if (typeof json?.error?.message === 'string') throw new Error(json.error.message)
  throw new Error(`转写响应形状不对：${JSON.stringify(json).slice(0, 200)}`)
}

/** 调转写端点（I/O 唯一出口）：multipart 上传，超时 60s（长音频转写要等） */
export async function transcribe(
  cfg: AsrConfig,
  audio: { data: Buffer; mime: string; name?: string },
): Promise<{ text: string; elapsedMs: number }> {
  const base = (audio.mime || '').split(';')[0].trim().toLowerCase()
  const ext = MIME_EXT[base] ?? 'bin'
  const form = new FormData()
  form.append('model', cfg.model)
  form.append('file', new Blob([audio.data], { type: base }), audio.name || `recording.${ext}`)
  const t0 = Date.now()
  const res = await fetch(`${cfg.baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(60_000),
  })
  const json = await res.json().catch(() => null)
  if (!res.ok) {
    const detail = typeof json?.error === 'string' ? json.error : (json?.error?.message ?? '')
    throw new Error(`转写端点 ${res.status}：${detail || res.statusText}`)
  }
  return { text: parseTranscription(json), elapsedMs: Date.now() - t0 }
}
