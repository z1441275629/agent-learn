// 会话账本路由：列表 / 新建 / 详情 / 删除 / 图片（图片走独立 URL，base64 不进 JSON）
import Router from '@koa/router'
import { json } from '../http.ts'
import { sessionDetail } from '../chat-service.ts'
import { sessionAllows, store } from '../state.ts'

export const router = new Router()

router.get('/api/sessions', async (ctx) => {
  return json(ctx, 200, { sessions: await store.list() })
})

router.post('/api/sessions', async (ctx) => {
  const doc = await store.create()
  return json(ctx, 200, { session: sessionDetail(doc) })
})

router.get('/api/sessions/:id', async (ctx) => {
  const doc = await store.load(ctx.params.id)
  if (!doc) return json(ctx, 404, { error: '会话不存在' })
  return json(ctx, 200, { session: sessionDetail(doc) })
})

router.delete('/api/sessions/:id', async (ctx) => {
  await store.remove(ctx.params.id)
  sessionAllows.delete(ctx.params.id) // 会话没了，它的「总是允许」授权跟着走
  return json(ctx, 200, { ok: true })
})

router.get('/api/sessions/:id/images/:file', async (ctx) => {
  const image = await store.readImage(ctx.params.id, ctx.params.file)
  if (!image) return json(ctx, 404, { error: '图片不存在' })
  ctx.status = 200
  ctx.type = image.mime
  ctx.set('Cache-Control', 'private, max-age=31536000, immutable')
  ctx.body = image.data
})
