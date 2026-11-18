// GET /api/chat/running（在跑发现）+ GET /api/chat/:sid/stream（SSE 续接）+ POST /api/chat/:sid/stop（显式停止）。
// 续接配方与 chat.ts 同款：ctx.respond=false 接管原生 res 写 SSE。
// 并发说明：回放→挂 client 之间是同步代码（无 await），生成循环的 send 不可能插队——无丢帧窗口
import Router from '@koa/router'
import type { ServerResponse } from 'node:http'
import { json } from '../http.ts'
import { armGraceIfIdle, cancelGrace, pendingConfirms, streamBuffers } from '../state.ts'

const NL = String.fromCharCode(10)

/** 接管原生 res 开 SSE（头三件套与 chat.ts 一致） */
function openSse(ctx: { respond?: boolean; res: ServerResponse }): void {
  ctx.respond = false
  ctx.res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
}

export const router = new Router()

/** 在跑会话清单：前端刷新后据此恢复列表「进行中」标记（宽限期内的续跑也算在跑） */
router.get('/api/chat/running', (ctx) => {
  json(ctx, 200, { sessionIds: [...streamBuffers.keys()] })
})

/** SSE 续接：回放缓冲帧（id > lastEventId）+ 挂为 live client；会话没在跑 → idle 帧后关。
 * lastEventId 非法值（负数/NaN）落 0，越界由比较天然 clamp——绝不 500 */
router.get('/api/chat/:sid/stream', (ctx) => {
  const sid = String(ctx.params.sid ?? '')
  const buf = streamBuffers.get(sid)
  const last = Math.max(0, Number.parseInt(String(ctx.query.lastEventId ?? '0'), 10) || 0)
  openSse(ctx)
  const res = ctx.res
  const write = (line: string) => {
    if (!res.destroyed && !res.writableEnded) res.write(line)
  }
  if (!buf) {
    write('data: {"type":"idle"}' + NL + NL)
    res.end()
    return
  }
  for (const f of buf.frames) {
    if (f.id > last) write('id: ' + f.id + NL + 'data: ' + f.json + NL + NL)
  }
  buf.clients.add(res)
  // 有人回来了：宽限计时作废（生成继续给活人看）——撤销逻辑统一在 state.ts
  if (buf.graceTimer) {
    cancelGrace(buf)
    console.log('[pa] chat 客户端重连，宽限取消 · session ' + sid)
  }
  res.on('close', () => {
    buf.clients.delete(res)
    // 这个观众也走光了：重新武装宽限计时——不补挂的话生成会在零观众下跑到自然结束
    // （plan/composite 能跑几分钟，正是宽限期要防的无界烧钱）
    armGraceIfIdle(sid, buf)
  })
})

/** 显式停止：abort 后由 chat.ts 的 aborted 分支统一落盘+收尾（含 stopped 帧广播） */
router.post('/api/chat/:sid/stop', (ctx) => {
  const sid = String(ctx.params.sid ?? '')
  const buf = streamBuffers.get(sid)
  if (!buf) return json(ctx, 404, { error: '该会话没有进行中的回答' })
  buf.abort.abort()
  // 还挂在确认卡上等人点：跟着停止一起拒绝收尾——否则循环阻塞在 askConfirm 上，
  // /running 一直报在跑、下次发送一直 409，最长卡满 CONFIRM_TIMEOUT_MS（终审 I5）
  for (const p of pendingConfirms.values()) if (p.sid === sid) p.settle(false, 'denied')
  json(ctx, 200, { ok: true })
})
