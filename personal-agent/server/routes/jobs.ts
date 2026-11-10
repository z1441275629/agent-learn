// 定时任务路由：任务面板数据（GET）/ 立即跑一个（POST run）/ 开关任务（POST toggle）。
// 前端零改动的第一版：配置手改 jobs.json 或用这三个接口管；面板 UI 等日用反馈再上
import Router from '@koa/router'
import { json, readJsonBody } from '../http.ts'
import { loadJobDefs, loadJobState, saveJobDefs } from '../../core/job-schedule.ts'
import { jobDeps, jobInFlight, runJobNow } from '../jobs.ts'

export const router = new Router()

/** GET /api/jobs：任务清单 + 各自最近状态 + 当前在跑的（面板一屏看全） */
router.get('/api/jobs', async (ctx) => {
  const jobs = loadJobDefs(jobDeps.dataDir)
  const state = loadJobState(jobDeps.dataDir)
  return json(ctx, 200, {
    jobs: jobs.map((j) => ({ ...j, state: state[j.id] ?? null })),
    inFlight: jobInFlight(),
  })
})

/** POST /api/jobs/:id/run：立即跑（不等结果——长任务 HTTP 会超时，结果进收件箱会话 + toast） */
router.post('/api/jobs/:id/run', async (ctx) => {
  const job = loadJobDefs(jobDeps.dataDir).find((j) => j.id === ctx.params.id)
  if (!job) return json(ctx, 404, { error: `没有这个任务：${ctx.params.id}` })
  if (jobInFlight()) return json(ctx, 409, { error: `任务「${jobInFlight()}」还在跑，稍后再试` })
  // fire-and-forget：runJobNow 自带 catch-all（失败也返回状态），这里只兜意外
  runJobNow(job, 'manual', jobDeps).catch((err) => console.error('[pa] 手动任务异常：', err?.message ?? err))
  return json(ctx, 202, { started: true, id: job.id })
})

/** POST /api/jobs/:id/toggle：翻转 enabled 并写回 jobs.json（生效即时——调度器每 tick 热读） */
router.post('/api/jobs/:id/toggle', async (ctx) => {
  const jobs = loadJobDefs(jobDeps.dataDir)
  const job = jobs.find((j) => j.id === ctx.params.id)
  if (!job) return json(ctx, 404, { error: `没有这个任务：${ctx.params.id}` })
  job.enabled = !job.enabled
  saveJobDefs(jobDeps.dataDir, jobs)
  return json(ctx, 200, { job })
})

/** POST /api/jobs：新增任务（body = JobDef 除 enabled 外的字段，enabled 默认关） */
router.post('/api/jobs', async (ctx) => {
  const body = await readJsonBody<any>(ctx)
  const jobs = loadJobDefs(jobDeps.dataDir)
  if (jobs.some((j) => j.id === body?.id)) return json(ctx, 409, { error: `任务 id 已存在：${body?.id}` })
  const job = {
    id: String(body?.id ?? ''),
    name: String(body?.name ?? body?.id ?? ''),
    enabled: false,
    hour: Number(body?.hour),
    minute: Number(body?.minute),
    ...(Array.isArray(body?.days) ? { days: body.days.map(Number) } : {}),
    text: String(body?.text ?? ''),
    allow: Array.isArray(body?.allow) ? body.allow.map(String) : [],
  }
  if (!/^[A-Za-z0-9_-]+$/.test(job.id)) return json(ctx, 400, { error: 'id 只能字母数字下划线连字符' })
  if (!(job.hour >= 0 && job.hour <= 23 && job.minute >= 0 && job.minute <= 59))
    return json(ctx, 400, { error: `hour/minute 非法：${body?.hour}:${body?.minute}` })
  if (!job.text.trim()) return json(ctx, 400, { error: 'text 不能为空（到点执行的用户消息）' })
  jobs.push(job)
  saveJobDefs(jobDeps.dataDir, jobs)
  return json(ctx, 200, { job })
})
