// 长期记忆路由：查看 / 删除 / 清空（用户能看到它记了什么，错了能删）
import Router from '@koa/router'
import { json } from '../http.ts'
import { memories } from '../state.ts'

export const router = new Router()

router.get('/api/memories', async (ctx) => {
  return json(ctx, 200, { memories: await memories.list() })
})

router.delete('/api/memories', async (ctx) => {
  await memories.clear()
  return json(ctx, 200, { ok: true })
})

router.delete('/api/memories/:id', async (ctx) => {
  const ok = await memories.remove(ctx.params.id)
  if (!ok) return json(ctx, 404, { error: '没有这条记忆' })
  return json(ctx, 200, { ok: true })
})
