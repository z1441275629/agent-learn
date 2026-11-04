// 截图取字：本地 tesseract（默认，带坐标）或视觉 LLM（版式强、无坐标）两条路线，翻译可选
import Router from '@koa/router'
import { recognize } from '../../ocr.ts'
import { recognizeWithAI } from '../../vision-ocr.ts'
import { translateLines } from '../../translate.ts'
import type { ChatUsage } from '../../chat.ts'
import { decodeImage, json, readJsonBody } from '../http.ts'

export const router = new Router()

router.post('/api/ocr', async (ctx) => {
  const body = await readJsonBody<{ image?: string; engine?: string }>(ctx)
  if (!body.image) return json(ctx, 400, { error: '缺 image 字段（dataURL 或 base64）' })
  const image = decodeImage(body.image)
  // 两条识别路线（模块 13 对照作业）：local=本地 tesseract（默认，带坐标）；ai=视觉 LLM（版式强、无坐标）
  const engine = body.engine === 'ai' ? 'ai' : 'local'
  const t0 = Date.now()
  const ocr = engine === 'ai' ? await recognizeWithAI(image) : await recognize(image)
  // OCR 秒级返回先给用户；翻译另有网络延迟——可选 ?translate=0 跳过（离线/省 token）
  let translations: { id: number; zh: string }[] = []
  let translateError: string | undefined
  let translateUsage: ChatUsage = null
  if (ctx.query.translate !== '0' && ocr.lines.length > 0) {
    const t = await translateLines(ocr.lines)
    translations = [...t.map].map(([id, zh]) => ({ id, zh }))
    translateError = t.error
    translateUsage = t.usage ?? null
  }
  console.log(
    `[pa] OCR(${ocr.engine}) ${ocr.lines.length} 行` +
      (typeof ocr.confidence === 'number' ? ` · 置信 ${Math.round(ocr.confidence)}` : '') +
      ` · ${ocr.elapsedMs}ms · 翻译 ${translations.length} 行${translateError ? `（失败：${translateError}）` : ''} · 总 ${Date.now() - t0}ms`,
  )
  // usage / translateUsage 都是服务商原始对象（含 cached/reasoning 明细）；本地 OCR 无计费时缺省
  return json(ctx, 200, { ...ocr, translations, translateError, translateUsage })
})
