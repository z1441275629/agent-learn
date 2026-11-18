// 会话账本路由：列表(分页) / 新建 / 详情 / 删除(在跑守卫) / 图片（图片走独立 URL，base64 不进 JSON）
import Router from '@koa/router'
import { json } from '../http.ts'
import { sessionDetail } from '../chat-service.ts'
import { runningSessions, sessionAllows, store, streamBuffers } from '../state.ts'

export const router = new Router()

router.get('/api/sessions', async (ctx) => {
  // 分页参数：解析失败回缺省（50），钳制防 500——非法值降级成合法查询，不报错
  const rawLimit = Number.parseInt(String(ctx.query.limit ?? ''), 10)
  const rawOffset = Number.parseInt(String(ctx.query.offset ?? ''), 10)
  const limit = Math.min(Math.max(Number.isNaN(rawLimit) ? 50 : rawLimit, 1), 200)
  const offset = Math.max(Number.isNaN(rawOffset) ? 0 : rawOffset, 0)
  const { sessions, total } = await store.list({ limit, offset })
  return json(ctx, 200, { sessions, total })
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
  const sid = ctx.params.id
  // 在跑守卫：runningSessions（正在回答）∪ streamBuffers（SSE 断开宽限期内 buffer 仍活着）——
  // 漏查 streamBuffers 会让宽限期续写往已删会话落盘，必须双查
  if (runningSessions.has(sid) || streamBuffers.has(sid)) {
    return json(ctx, 409, { error: '会话正在回答，先停止再删除' })
  }
  await store.remove(sid)
  sessionAllows.delete(sid) // 会话没了，它的「总是允许」授权跟着走
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
