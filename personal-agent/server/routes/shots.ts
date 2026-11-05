// GET /api/browser/shots/:file——体检截图的只读分发。
// 文件名白名单（服务端自己生成的形状），不存在目录穿越面；目录里只有 png。
import Router from '@koa/router'
import fs from 'node:fs'
import path from 'node:path'
import { json } from '../http.ts'
import { shots } from '../state.ts'

export const router = new Router()

router.get('/api/browser/shots/:file', (ctx) => {
  const file = String(ctx.params.file ?? '')
  if (!/^shot_[a-z0-9_]+\.png$/.test(file)) return json(ctx, 404, { error: '截图不存在' })
  const full = path.join(shots.dir, file)
  if (!fs.existsSync(full)) return json(ctx, 404, { error: '截图不存在或已清理' })
  ctx.type = 'image/png'
  ctx.body = fs.readFileSync(full)
})
