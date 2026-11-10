// POST /api/chat（SSE 流式对话，工具循环 + 确认门）+ POST /api/chat/confirm（卡上的允许/拒绝）。
// SSE 在 Koa 下的姿势：ctx.respond = false 绕过 Koa 的应答处理，直接拿原生 res 写帧——
// 换框架不换流控语义（断开 abort、半截落盘、门随流收尾都照旧）
import Router from '@koa/router'
import { DEFAULT_MODEL_ID, MODELS, thinkingParams } from '../../models.ts'
import { deriveTitle, type ChatUsage } from '../../chat.ts'
import type { StoredImage } from '../../core/sessions.ts'
import { runToolLoop, type ToolTrace } from '../../core/agent.ts'
import { json, readJsonBody } from '../http.ts'
import { kbContextFor, prepareContext, safeAppend, type ChatBody } from '../chat-service.ts'
import {
  CONFIRM_TIMEOUT_MS,
  pendingConfirms,
  repo,
  runMemoryExtraction,
  runningSessions,
  sessionAllows,
  store,
  tools,
} from '../state.ts'
import { routeMessage } from '../../core/router.ts'
import { runBlogComposite } from '../../core/composite.ts'

export const router = new Router()

/** POST /api/chat：校验 → 开 SSE → 会话帧 → 工具循环（写入工具过门）→ done/落盘 */
router.post('/api/chat', async (ctx) => {
  const body = await readJsonBody<ChatBody>(ctx)
  const entry = MODELS.find((m) => m.id === body.modelId) ?? MODELS.find((m) => m.id === DEFAULT_MODEL_ID)!
  const input = body.message
  if (!input || typeof input.text !== 'string')
    return json(ctx, 400, { error: '缺 message.text（新消息必须由客户端提供）' })
  const text = input.text
  const rawImages = Array.isArray(input.images) ? input.images : []
  if (!text.trim() && rawImages.length === 0) return json(ctx, 400, { error: '消息为空' })
  if (rawImages.length > 8) return json(ctx, 400, { error: '一轮最多 8 张图片' })
  // 图片能力前置校验放在动存储之前：失败的请求不许污染会话列表
  if (rawImages.length > 0 && !entry.vision)
    return json(ctx, 400, { error: `「${entry.label} · ${entry.model}」不支持图片输入——请切换到视觉模型` })

  const existing = body.sessionId ? await store.load(body.sessionId) : await store.create()
  if (!existing) return json(ctx, 404, { error: '会话不存在' })
  const sid = existing.id
  if (runningSessions.has(sid)) return json(ctx, 409, { error: '这个会话还在回答，先停止或等它结束' })
  runningSessions.add(sid)

  try {
    const storedImages: StoredImage[] = []
    for (const image of rawImages) {
      if (!image || typeof image.dataUrl !== 'string') return json(ctx, 400, { error: '图片缺 dataUrl' })
      storedImages.push(await store.saveImage(sid, image.dataUrl, image.name))
    }
    const doc = await store.append(
      sid,
      { role: 'user', text, images: storedImages },
      {
        title: deriveTitle(text, storedImages.length > 0),
        modelId: entry.id,
        thinking: body.thinking ?? 'off',
      },
    )

    // 工具模式（默认开）：模型可调工具——只读的直接跑，写入的（remember）先过确认门；
    // 知识库此时走工具检索，自动注入只在工具关闭时做（同一内容不双份进上下文）
    const toolsOn = body.tools !== false
    // 模块 16 总控路由：命中「写技术博客」意图 → 走多 agent 编排（composite）；否则单 agent 照旧。
    // 工具关闭时不路由——研究员子 agent 要只读工具取材
    const isComposite = toolsOn && routeMessage(text) === 'composite'
    const kbBlock = !toolsOn && !isComposite && body.kbSearch !== false ? await kbContextFor(doc) : null
    // composite 模式不建主循环上下文——编排自带各角色上下文
    const messages = !isComposite ? await prepareContext(doc, entry, body.imageElision !== false, kbBlock, toolsOn) : []

    // 从这里开始应答全是 SSE：接管原生 res（Koa 不再替我们收尾）——上面的校验/落账失败
    // 仍走 Koa 正常的 JSON 错误路径，别让 respond=false 把错误帧也吞了
    ctx.respond = false
    const res = ctx.res
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    const send = (o: unknown) => {
      if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(o)}\n\n`)
    }
    // 第一帧就告诉前端会话 id/标题：新会话由服务端创建，前端据此刷新列表
    send({ type: 'session', sessionId: sid, title: doc.title })

    /** 出确认卡等人点：批准/拒绝/超时都给循环一个明确答复（超时也发 outcome 帧让卡片定格） */
    const askConfirm = (req: { name: string; args: string }) =>
      new Promise<boolean>((resolve) => {
        // 会话内已「总是允许」的工具直接放行：不出卡（工具芯片照常留痕，审计不缺）
        if (sessionAllows.get(sid)?.has(req.name)) {
          console.log(`[pa] ${req.name} 本会话已总允许，自动放行 · session ${sid}`)
          return resolve(true)
        }
        // 卡面内容：工具提供 describe 就把参数解析成人话（browser_click 的 {"ref":3} →
        // 「[3] button「登录」」），否则参数原文。解析失败/参数非法都回落原文，卡绝不能因它崩
        let cardArgs = req.args
        try {
          const def = tools.find((t) => t.name === req.name)
          if (def?.describe) cardArgs = String(def.describe(JSON.parse(req.args || '{}')))
        } catch {
          cardArgs = req.args
        }
        const confirmId = `cf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
        const settle = (approve: boolean, outcome: 'approved' | 'denied' | 'timeout') => {
          clearTimeout(timer)
          pendingConfirms.delete(confirmId)
          send({ type: 'confirm', confirmId, outcome })
          resolve(approve)
        }
        const timer = setTimeout(() => settle(false, 'timeout'), CONFIRM_TIMEOUT_MS)
        pendingConfirms.set(confirmId, { sid, name: req.name, settle })
        send({ type: 'confirm', confirmId, name: req.name, args: cardArgs })
        console.log(`[pa] 等待确认 ${req.name} ${cardArgs.slice(0, 80)} · session ${sid}`)
      })

    // 客户端断开/点停止 → abort 上游，别让没人看的长回答继续烧 token；半截回答仍要落盘；
    // 还没应答的确认卡按拒绝收尾（门不能比流活得久）
    const ac = new AbortController()
    res.on('close', () => {
      if (!res.writableEnded) {
        ac.abort()
        for (const p of pendingConfirms.values()) if (p.sid === sid) p.settle(false, 'denied')
      }
    })
    const t0 = Date.now()
    // 服务端自己留一份已流出文本：runToolLoop 抛错（网络等）时半截内容还在手里，能落盘
    let streamedText = ''
    let streamedTrace: ToolTrace[] = []
    const saveInterrupted = async (elapsedMs: number) => {
      if (streamedText) {
        await safeAppend(sid, {
          role: 'assistant',
          text: streamedText,
          model: entry.model,
          elapsedMs,
          interrupted: true,
          tools: streamedTrace.length ? streamedTrace : undefined,
        })
      }
      console.log(`[pa] chat 已停止 · ${streamedText.length} 字 · session ${sid}`)
    }
    try {
      if (isComposite) {
        // 模块 16 总控·写博客编排：研究员→审校①→写手→审校②，角色 trace 走 tool 帧（前端芯片零改动）；
        // 终稿落盘复用 write_file 确认门（卡上展示路径+内容预览）；中止时 saveInterrupted 语义直接落盘
        const lightEntry = MODELS.find((m) => m.id === 'light')
        const comp = await runBlogComposite(text, {
          entry,
          lightEntry,
          readTools: tools.filter((t) => t.risk === 'read'),
          signal: ac.signal,
          emit: (tr) => {
            streamedTrace = [...streamedTrace, tr]
            send({ type: 'tool', name: tr.name, args: tr.args, result: tr.result, ms: tr.ms })
          },
        })
        const elapsedMs = Date.now() - t0
        // 终稿落盘确认：只对过审稿（done）弹卡（熔断/护栏的停机报告不是博客，不落盘）；
        // aborted 时也不再弹卡——编排已被中止
        let writeTrace: ToolTrace | null = null
        if (comp.stoppedBy === 'done' && comp.finalBlog && !ac.signal.aborted) {
          const approveArgs = JSON.stringify({ path: comp.slugPath, content: comp.finalBlog })
          const approved = await askConfirm({ name: 'write_file', args: approveArgs })
          if (approved) {
            const wt0 = Date.now()
            const out = await repo.writeFile(comp.slugPath, comp.finalBlog)
            writeTrace = { name: 'write_file', args: approveArgs, result: out, ms: Date.now() - wt0 }
            send({ type: 'tool', name: 'write_file', args: approveArgs, result: out, ms: Date.now() - wt0 })
          }
        }
        const usage: ChatUsage = {
          prompt_tokens: comp.promptTokens,
          completion_tokens: comp.completionTokens,
          total_tokens: comp.promptTokens + comp.completionTokens,
        }
        const finalText =
          comp.stoppedBy === 'done' && writeTrace
            ? `${comp.finalBlog}\n\n---\n已保存：${comp.slugPath}`
            : comp.stoppedBy === 'done'
              ? `${comp.finalBlog}\n\n---\n（未保存——你拒绝了落盘确认，全文如上可复制）`
              : `${comp.finalBlog}\n\n未解决项：\n${comp.openIssues.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
        const traceAll = [...comp.trace, ...(writeTrace ? [writeTrace] : [])]
        if (ac.signal.aborted) {
          // 中止：把已产出的部分按 interrupted 落盘（streamedText 在 composite 分支恒空，不走 saveInterrupted）
          await safeAppend(sid, {
            role: 'assistant',
            text: finalText || '（编排被中止，无产出）',
            model: entry.model,
            elapsedMs,
            interrupted: true,
            tools: traceAll.length ? traceAll : undefined,
          })
          console.log(`[pa] composite 已停止 · ${finalText.length} 字 · session ${sid}`)
        } else {
          await safeAppend(sid, {
            role: 'assistant',
            text: finalText,
            usage,
            model: entry.model,
            elapsedMs,
            tools: traceAll.length ? traceAll : undefined,
          })
          send({
            type: 'done',
            text: finalText,
            usage,
            model: entry.model,
            modelId: entry.id,
            sessionId: sid,
            elapsedMs,
            tools: traceAll.length ? traceAll : undefined,
          })
          console.log(
            `[pa] composite ${entry.id}(${entry.model}) · ${comp.finalBlog.length} 字 · ${usage?.total_tokens ?? '?'} tokens` +
              ` · ${comp.stoppedBy} · ${elapsedMs}ms · session ${sid}`,
          )
          runMemoryExtraction(sid, text)
        }
      } else {
        const result = await runToolLoop(entry.client, entry.model, messages, {
          tools: toolsOn ? tools : [],
          signal: ac.signal,
          maxRounds: 5,
          // 工具结果在循环层的截断兜底：browser_read 自带 6000 字正文 + 元素索引，
          // 1200 的默认值会把网页结果拦腰砍断（工具内部各自有源头截断，这里只是保险网）
          maxResultChars: 9000,
          extraBody: thinkingParams(body.thinking ?? 'off'),
          onConfirm: askConfirm,
          onText: (delta) => {
            streamedText += delta
            send({ type: 'delta', text: delta })
          },
          onToolCall: (t) => {
            streamedTrace = [...streamedTrace, t]
            send({ type: 'tool', name: t.name, args: t.args, result: t.result, ms: t.ms })
          },
        })
        const elapsedMs = Date.now() - t0
        const usage: ChatUsage = result.usage ?? null
        if (result.aborted || ac.signal.aborted) {
          // 关键实测：OpenAI SDK 的上游流被 abort 时常常是「正常结束」而不是抛错，
          // 所以不能只靠 catch 判断用户是否点了停止——循环结束后必须再看一次信号。
          await saveInterrupted(elapsedMs)
        } else {
          await safeAppend(sid, {
            role: 'assistant',
            text: result.text,
            usage,
            model: entry.model,
            elapsedMs,
            tools: result.trace.length ? result.trace : undefined,
          })
          send({
            type: 'done',
            text: result.text,
            usage,
            model: entry.model,
            modelId: entry.id,
            sessionId: sid,
            elapsedMs,
            tools: result.trace.length ? result.trace : undefined,
          })
          console.log(
            `[pa] chat ${entry.id}(${entry.model}) · ${result.text.length} 字 · ${usage?.total_tokens ?? '?'} tokens` +
              ` · 工具 ${result.rounds} 轮${result.trace.length ? `（${result.trace.map((t) => t.name).join(',')}）` : ''}` +
              ` · ${elapsedMs}ms · session ${sid}`,
          )
          // 回答完整落盘后才抽记忆：半截/出错的回答不抽（对话可能还没说完）
          runMemoryExtraction(sid, text)
        }
      }
    } catch (err: any) {
      const elapsedMs = Date.now() - t0
      if (ac.signal.aborted) {
        // 用户主动停止：把已经生成的部分存进账本，下次进来还能接着聊
        await saveInterrupted(elapsedMs)
      } else {
        const msg = String(err?.message ?? err).slice(0, 300)
        // 失败的 assistant 消息落盘（error 非空）——界面能看到，但 buildApiMessages 会把它排除出上下文。
        // 已流出的半截文本一并保留：工具循环可能第二轮才断网，前一轮的字用户已经看到了
        await safeAppend(sid, {
          role: 'assistant',
          text: streamedText,
          error: msg,
          model: entry.model,
          elapsedMs,
          tools: streamedTrace.length ? streamedTrace : undefined,
        })
        send({ type: 'error', error: msg })
      }
    }
    res.end()
  } finally {
    runningSessions.delete(sid)
  }
})

/** POST /api/chat/confirm：确认卡应答（允许/拒绝；勾「本会话总是允许」时 approve+always 一起带）。
 * 找不到 = 已处理/已超时/已断流 */
router.post('/api/chat/confirm', async (ctx) => {
  const body = await readJsonBody<{ confirmId?: string; approve?: boolean; always?: boolean }>(ctx)
  const pending = pendingConfirms.get(String(body.confirmId ?? ''))
  if (!pending) return json(ctx, 404, { error: '确认请求不存在或已处理' })
  pending.settle(body.approve === true, body.approve === true ? 'approved' : 'denied')
  if (body.approve === true && body.always === true) {
    let set = sessionAllows.get(pending.sid)
    if (!set) {
      set = new Set()
      sessionAllows.set(pending.sid, set)
    }
    set.add(pending.name)
    console.log(`[pa] 本会话总是允许 ${pending.name} · session ${pending.sid}`)
  }
  return json(ctx, 200, { ok: true })
})
