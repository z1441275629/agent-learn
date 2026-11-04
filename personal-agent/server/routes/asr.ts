// 大模型语音转写（方式①）：前端 MediaRecorder 整段上传 → OpenAI 兼容转写端点 → 文本回输入框
import Router from '@koa/router'
import { transcribe, validateAsrAudio } from '../../asr.ts'
import { json, readJsonBody } from '../http.ts'
import { ASR } from '../state.ts'

export const router = new Router()

router.post('/api/asr', async (ctx) => {
  if (!ASR) return json(ctx, 503, { error: '未配置转写端点（PA_ASR_BASE_URL / PA_ASR_API_KEY，或回落小档/embed 档）' })
  const body = await readJsonBody<{ audio?: string; mime?: string; name?: string }>(ctx)
  if (typeof body.audio !== 'string' || !body.audio)
    return json(ctx, 400, { error: '缺 audio 字段（dataURL 或 base64）' })
  // dataURL 前缀自带 mime（可带 ;codecs=… 等参数——MediaRecorder 的 Blob type 就有），优先于 body.mime
  let mime = String(body.mime ?? '')
  let b64 = body.audio
  const s = body.audio.trim()
  if (s.startsWith('data:')) {
    const comma = s.indexOf(',')
    const meta = s.slice(5, comma) // 形如 audio/webm;codecs=opus;base64
    const cut = meta.lastIndexOf(';base64')
    if (cut >= 0) {
      mime = meta.slice(0, cut)
      b64 = s.slice(comma + 1)
    }
  }
  const data = Buffer.from(b64, 'base64')
  const check = validateAsrAudio(mime, data.length)
  if (!check.ok) return json(ctx, check.code, { error: check.error })
  try {
    const r = await transcribe(ASR, { data, mime, name: body.name })
    console.log(`[pa] 语音转写 ${ASR.model} · ${(data.length / 1024) | 0}KB · ${r.text.length} 字 · ${r.elapsedMs}ms`)
    return json(ctx, 200, { text: r.text, elapsedMs: r.elapsedMs, model: ASR.model })
  } catch (err: any) {
    return json(ctx, 502, { error: `转写失败：${err?.message ?? err}` })
  }
})
