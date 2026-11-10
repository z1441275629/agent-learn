// Koa 应用组装：错误映射中间件 → 静态托管（非 /api 的 GET）→ 各域路由 → 404 兜底。
// createApp() 返回实例不监听——入口（index.ts）负责 listen，测试/未来嵌入可复用
import fs from 'node:fs/promises'
import path from 'node:path'
import Koa from 'koa'
import { fileURLToPath } from 'node:url'
import { router as chatRouter } from './routes/chat.ts'
import { router as sessionsRouter } from './routes/sessions.ts'
import { router as memoriesRouter } from './routes/memories.ts'
import { router as kbRouter } from './routes/kb.ts'
import { router as skillsRouter } from './routes/skills.ts'
import { router as modelsRouter } from './routes/models.ts'
import { router as asrRouter } from './routes/asr.ts'
import { router as ocrRouter } from './routes/ocr.ts'
import { router as shotsRouter } from './routes/shots.ts'
import { router as jobsRouter } from './routes/jobs.ts'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.resolve(DIR, '../public') // Vue 构建产物（源码 web/，构建输出 public/）

const STATIC_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
}

/** 托管 Vue 构建产物。返回 false = 没这个文件（交给 404 兜底） */
async function readStatic(pathname: string): Promise<{ data: Buffer; mime: string } | null> {
  let rel: string
  try {
    rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '')
  } catch {
    return null
  }
  const file = path.resolve(PUBLIC_DIR, rel)
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return null // 防 ../ 目录穿越
  try {
    const data = await fs.readFile(file)
    return { data, mime: STATIC_MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream' }
  } catch {
    return null
  }
}

export function createApp(): Koa {
  const app = new Koa()

  // 错误映射：业务错误带数字 code（400/404/409/413/502）按码回，其余 500；
  // SSE 已经开流后（headerSent）再抛只能日志收尾——头部都发出去了，改不了状态码
  app.use(async (ctx, next) => {
    try {
      await next()
    } catch (err: any) {
      const code = [400, 404, 409, 413, 502].includes(err?.code) ? err.code : 500
      if (code === 500) console.error('[pa] 炸了：', err?.message)
      if (ctx.headerSent || ctx.respond === false) {
        ctx.res.destroy()
        return
      }
      ctx.status = code
      ctx.type = 'application/json; charset=utf-8'
      ctx.body = JSON.stringify({ error: err?.message ?? '未知错误' })
    }
  })

  // 前端静态资源（Vue 构建产物）；/api/* 交给下面的路由
  app.use(async (ctx, next) => {
    if (ctx.method === 'GET' && !ctx.path.startsWith('/api')) {
      const file = await readStatic(ctx.path)
      if (file) {
        ctx.status = 200
        ctx.type = file.mime
        // 产物文件名固定（方便 git diff），所以不能长缓存——每次协商，避免换版后拿旧 JS
        ctx.set('Cache-Control', 'no-cache')
        ctx.body = file.data
        return
      }
    }
    await next()
  })

  app.use(chatRouter.routes())
  app.use(sessionsRouter.routes())
  app.use(memoriesRouter.routes())
  app.use(kbRouter.routes())
  app.use(skillsRouter.routes())
  app.use(modelsRouter.routes())
  app.use(asrRouter.routes())
  app.use(ocrRouter.routes())
  app.use(shotsRouter.routes())
  app.use(jobsRouter.routes())

  // 404 兜底：非 /api 的 GET 是「没这个文件」（提示先构建前端），其余是「没这个路由」
  app.use(async (ctx) => {
    if (ctx.method === 'GET' && !ctx.path.startsWith('/api')) {
      ctx.status = 404
      ctx.type = 'application/json; charset=utf-8'
      ctx.body = JSON.stringify({
        error: `没这个文件：${ctx.path}${ctx.path === '/' ? '（先跑 npm run pa:build 生成 frontend）' : ''}`,
      })
      return
    }
    ctx.status = 404
    ctx.type = 'application/json; charset=utf-8'
    ctx.body = JSON.stringify({ error: `没这个路由：${ctx.method} ${ctx.path}` })
  })

  return app
}
