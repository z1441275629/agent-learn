// 知识库路由：个人笔记上传 → 切块索引 → 对话时 BM25 检索注入
import Router from '@koa/router'
import { json, readJsonBody } from '../http.ts'
import { kb } from '../state.ts'

export const router = new Router()

router.get('/api/kb', async (ctx) => {
  return json(ctx, 200, { docs: await kb.list() })
})

router.post('/api/kb', async (ctx) => {
  const body = await readJsonBody<{ name?: string; text?: string }>(ctx)
  const doc = await kb.add(String(body.name ?? ''), String(body.text ?? ''))
  console.log(`[pa] 知识库 +《${doc.name}》（${doc.chunkCount} 块）`)
  return json(ctx, 200, { doc })
})

router.delete('/api/kb/:id', async (ctx) => {
  const ok = await kb.remove(ctx.params.id)
  if (!ok) return json(ctx, 404, { error: '没有这个文档' })
  return json(ctx, 200, { ok: true })
})
