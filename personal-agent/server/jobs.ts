// 模块 16 第三层·定时任务运行时：无头执行（把任务文本当一条用户消息跑，路由三态照常分流）
// + 分钟级调度器 + 推送（Windows 原生通知 + 会话收件箱——任务产出落成真实会话，侧边栏可见）。
// 纯逻辑（触发判定/确认门/配置 IO）在 core/job-schedule.ts，这里只做组装与副作用。
//
// 无头语义（没人守着界面，三条都从 chat 路由的对等语义推下来）：
//   - 确认门：allow 清单外的 write 工具当场拒绝（SSE 门是「没人应答按拒绝」，无头门不白等超时）
//   - 推送：任务没人盯着，成功与失败都要通知到人（toast），产物进会话（收件箱）
//   - 成本护栏：plan/composite/normal 各自的内部护栏照常生效（CEILING/maxCalls/熔断），这里不再加一层
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runToolLoop, type ToolDef, type ToolTrace } from '../core/agent.ts'
import { runPlan } from '../core/plan.ts'
import { planTask } from '../core/planner.ts'
import { runBlogComposite } from '../core/composite.ts'
import { routeMessage } from '../core/router.ts'
import {
  JOBS_FILE,
  loadJobDefs,
  loadJobState,
  makeHeadlessConfirm,
  needsCatchup,
  saveJobState,
  shouldFireNow,
  slotToday,
  type JobDef,
  type JobStateEntry,
} from '../core/job-schedule.ts'
import { DEFAULT_MODEL_ID, MODELS, thinkingParams, type ModelEntry } from '../models.ts'
import { deriveTitle } from '../chat.ts'
import type { SessionDoc, SessionStore } from '../core/sessions.ts'
import type { SkillStore } from '../core/skills.ts'
import type { RepoReader } from '../repo.ts'
import { prepareContext } from './chat-service.ts'
import { config, repo, runMemoryExtraction, skills, store, tools } from './state.ts'
import type { AppendOptions, NewMessage } from '../core/sessions.ts'

/** 无头运行的依赖集合（探针可注入假 prepare/extractMemory + 临时 store 走零 token 路径） */
export interface JobDeps {
  entry: ModelEntry
  lightEntry: ModelEntry | undefined
  allTools: ToolDef[]
  readTools: ToolDef[]
  skills: SkillStore
  store: SessionStore
  repo: RepoReader
  dataDir: string
  /** 上下文组装（缺省接 chat-service.prepareContext；探针注入假实现避免拉真模型配置） */
  prepare?: (doc: SessionDoc, entry: ModelEntry) => Promise<any[]>
  /** 回答完成后的记忆抽取钩子（缺省接 state 的 runMemoryExtraction；探针注入 noop 不烧 token） */
  extractMemory?: (sid: string, userText: string) => void
}

// 进程级单闸：同一时刻只跑一个任务（定时/手动共用——token 纪律，错峰任务排队到下一 tick）
let currentJobId: string | null = null
let currentJobName = ''
export function jobInFlight(): string | null {
  return currentJobId
}

// ---------- Windows 通知（零依赖：Win11 原生 ToastText02 模板 + PowerShell 的 AUMID） ----------
// fire-and-forget：通知失败绝不影响任务本身（推送是增强不是依赖——收件箱会话才是主通道）。
// PA_JOBS_TOAST=0 关掉（比如不喜欢弹窗、或服务器跑在无桌面会话里）
export function notifyWindows(title: string, body: string): void {
  if (process.platform !== 'win32' || process.env.PA_JOBS_TOAST === '0') return
  try {
    // PS 单引号字符串转义：' → ''；长度截断防模板爆行
    const esc = (s: string) => s.replace(/'/g, "''").replace(/\r?\n/g, ' · ').slice(0, 120)
    const script = [
      '[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime] | Out-Null',
      '$x=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
      `$null=$x.GetElementsByTagName('text').Item(0).AppendChild($x.CreateTextNode('${esc(title)}'))`,
      `$null=$x.GetElementsByTagName('text').Item(1).AppendChild($x.CreateTextNode('${esc(body)}'))`,
      // AUMID 借 PowerShell 自己的：未注册的自定义 AppId 在部分构建上静默不弹，借壳最稳
      "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($x))",
    ].join('\n')
    // 命令行转义太脆（cmd + PS 两层），落临时 .ps1 再 -File 执行——脚本里可以放心用单双引号
    const file = path.join(os.tmpdir(), `pa-toast-${Date.now().toString(36)}.ps1`)
    fs.writeFileSync(file, script, 'utf8')
    execFile(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file],
      { timeout: 15_000, windowsHide: true },
      () => fs.rm(file, () => {}),
    )
  } catch {
    /* 通知挂了就挂了——任务结果在收件箱会话里，丢的只是一声铃 */
  }
}

// ---------- 无头执行：一次任务 = 一条会话（收件箱） ----------

/** 状态落盘在 runJobNow 本体做（成功/失败都落）：手动跑也要消耗磁盘上的当天槽位，
 *  否则「晚上手动复盘过、21 点又自动跑一遍」——去重键在盘上，不在调用方手里 */
function persistJobState(deps: JobDeps, jobId: string, entry: JobStateEntry): void {
  const all = loadJobState(deps.dataDir)
  all[jobId] = entry
  saveJobState(deps.dataDir, all)
}

/** 会话追加走 deps.store（不借 chat-service 的 safeAppend——它绑死全局单例，穿透依赖注入：
 *  探针注入临时 store 时会写串）。持久化失败只报错不抛，别把进行中的任务带崩 */
async function appendSafe(
  deps: JobDeps,
  sid: string,
  message: NewMessage,
  opts?: AppendOptions,
): Promise<SessionDoc | null> {
  try {
    return await deps.store.append(sid, message, opts)
  } catch (err: any) {
    console.error(`[pa] 定时会话 ${sid} 保存失败：${err?.message}`)
    return null
  }
}

/**
 * 立即跑一个任务（定时触发/启动补跑/手动「现在跑」共用）。
 * 永不抛错：失败也返回带 error 状态的 JobStateEntry 并推送通知——调度器不该被单任务炸停。
 */
export async function runJobNow(
  job: JobDef,
  trigger: 'schedule' | 'catchup' | 'manual',
  deps: JobDeps,
): Promise<JobStateEntry> {
  if (currentJobId)
    throw Object.assign(new Error(`定时任务「${currentJobName}」还在跑，稍后再试`), { code: 409 })
  currentJobId = job.id
  currentJobName = job.name
  const t0 = Date.now()
  let sid: string | undefined
  try {
    const entry = deps.entry
    const userText = `⏰ 定时任务「${job.name}」\n${job.text}`
    sid = (await deps.store.create()).id
    const doc = await appendSafe(
      deps,
      sid,
      { role: 'user', text: userText, images: [] },
      { title: deriveTitle(userText, false), modelId: entry.id, thinking: 'medium' },
    )
    if (!doc) throw new Error('收件箱会话首条消息写入失败（data 目录不可写？）——任务中止')
    const denied: string[] = []
    const onConfirm = makeHeadlessConfirm(job.allow, denied)
    const traces: ToolTrace[] = []
    let finalText = ''
    let usage: any = null
    let statusLabel = 'done'

    // normal 主路径（plan 解析失败的回落也是它）：完整工具面 + 确认门 + medium 思考，参数对齐 chat 路由
    const runNormal = async (): Promise<void> => {
      const messages = deps.prepare
        ? await deps.prepare(doc, entry)
        : await prepareContext(doc, entry, true, null, true)
      const res = await runToolLoop(entry.client, entry.model, messages, {
        tools: deps.allTools,
        maxRounds: 5,
        maxResultChars: 9000,
        extraBody: thinkingParams('medium'),
        onConfirm,
        onToolCall: (t) => traces.push(t),
      })
      usage = res.usage
      finalText = res.text
    }

    const mode = routeMessage(job.text)
    if (mode === 'plan') {
      const outcome = await planTask(job.text, { entry: deps.lightEntry ?? entry })
      if (!outcome) {
        await runNormal() // 规划 fail-closed：回落单 agent，和 chat 路由同语义
      } else {
        traces.push({
          name: '规划师',
          args: job.text.slice(0, 60),
          result: outcome.steps.map((s, i) => `${i + 1}. [${s.capability}] ${s.goal}`).join('\n'),
          ms: 0,
        })
        const r = await runPlan(job.text, outcome.steps, {
          entry,
          lightEntry: deps.lightEntry,
          allTools: deps.allTools,
          readTools: deps.readTools,
          skills: deps.skills,
          onConfirm,
          // 博客步骤落盘门：无头版 = 同一张 allow 清单（write_file 在清单里就落盘，不在就拒并记进 denied）
          saveBlog: async (p, content) => {
            if (!(await onConfirm({ name: 'write_file' }))) return false
            const wt0 = Date.now()
            const out = await deps.repo.writeFile(p, content)
            traces.push({ name: 'write_file', args: JSON.stringify({ path: p }), result: out, ms: Date.now() - wt0 })
            return true
          },
          emit: (tr) => traces.push(tr), // CompositeRoleTrace 与 ToolTrace 结构同形
        })
        // usage 并账：执行链 + 规划师自身调用（PITFALLS #60——无头也不能漏）
        const prompt = r.promptTokens + outcome.promptTokens
        const completion = r.completionTokens + outcome.completionTokens
        usage = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion }
        finalText = r.finalText
        statusLabel = r.stoppedBy === 'done' ? 'done' : r.stoppedBy
      }
    } else if (mode === 'composite') {
      const comp = await runBlogComposite(job.text, {
        entry,
        lightEntry: deps.lightEntry,
        readTools: deps.readTools,
        emit: (tr) => traces.push(tr),
      })
      let tail = ''
      if (comp.stoppedBy === 'done' && comp.finalBlog) {
        if (await onConfirm({ name: 'write_file' })) {
          const wt0 = Date.now()
          const out = await deps.repo.writeFile(comp.slugPath, comp.finalBlog)
          traces.push({ name: 'write_file', args: JSON.stringify({ path: comp.slugPath }), result: out, ms: Date.now() - wt0 })
          tail = `\n\n---\n已保存：${comp.slugPath}`
        } else {
          tail = '\n\n---\n（未保存——allow 清单未含 write_file，全文如上）'
        }
      }
      usage = {
        prompt_tokens: comp.promptTokens,
        completion_tokens: comp.completionTokens,
        total_tokens: comp.promptTokens + comp.completionTokens,
      }
      finalText =
        comp.stoppedBy === 'done'
          ? `${comp.finalBlog}${tail}`
          : `${comp.finalBlog}\n\n未解决项：\n${comp.openIssues.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
      statusLabel = comp.stoppedBy
    } else {
      await runNormal()
    }

    // 无头拒绝要可见：被拒工具附在产出末尾，人打开收件箱会话就知道这轮缺了什么、怎么补
    if (denied.length)
      finalText += `\n\n---\n⚠ 无头运行被拒的写入工具：${denied.join('、')}——需要就把该工具加进 jobs.json 里这个任务的 allow`
    const elapsedMs = Date.now() - t0
    await appendSafe(deps, sid, {
      role: 'assistant',
      text: finalText || '（任务无文本产出）',
      usage,
      model: entry.model,
      elapsedMs,
      tools: traces.length ? traces : undefined,
    })
    ;(deps.extractMemory ?? runMemoryExtraction)(sid, job.text)
    const tokens = Number(usage?.total_tokens) || 0
    const triggerNote = trigger === 'catchup' ? ' · 补跑' : trigger === 'manual' ? ' · 手动' : ''
    const state: JobStateEntry = {
      lastRunAt: new Date().toISOString(),
      // 槽位按任务的计划时刻记（手动跑也消耗当天槽位——晚上 8 点手动复盘过，9 点就不该再自动跑一遍）
      lastSlot: slotToday(job, new Date()),
      lastStatus: `${statusLabel}${triggerNote} · ${(tokens / 1000).toFixed(1)}k tokens · ${Math.round(elapsedMs / 1000)}s`,
      lastSessionId: sid,
      lastTokens: tokens,
    }
    notifyWindows(`定时任务：${job.name}`, `${state.lastStatus} · 产出已在会话「${deriveTitle(userText, false)}」`)
    console.log(`[pa] 定时任务「${job.name}」${trigger} 完成 · ${state.lastStatus} · session ${sid}`)
    persistJobState(deps, job.id, state)
    return state
  } catch (err: any) {
    // 失败不炸调度器：错误进状态 + 通知（没人守着的任务，失败必须推送到人）+ 半截会话补一条错误消息
    const msg = String(err?.message ?? err).slice(0, 300)
    if (sid)
      await appendSafe(deps, sid, {
        role: 'assistant',
        text: `【定时任务出错】${msg}`,
        error: msg,
        model: deps.entry.model,
        elapsedMs: Date.now() - t0,
      })
    const state: JobStateEntry = {
      lastRunAt: new Date().toISOString(),
      lastSlot: slotToday(job, new Date()),
      lastStatus: `error: ${msg.slice(0, 160)}`,
      ...(sid ? { lastSessionId: sid } : {}),
    }
    notifyWindows(`定时任务失败：${job.name}`, state.lastStatus)
    console.error(`[pa] 定时任务「${job.name}」失败：`, msg)
    persistJobState(deps, job.id, state)
    return state
  } finally {
    currentJobId = null
  }
}

// ---------- 调度器 ----------

/**
 * 分钟级调度：20s 一 tick，到点触发 + 当天漏跑补跑（配置热读——jobs.json 手改即生效，不用重启）。
 * 返回 stop 函数（清 interval；正在跑的任务不硬杀，进程退出自然收尾）。
 * PA_JOBS_DISABLED=1 整体停用。
 */
export function startJobScheduler(deps: JobDeps): () => void {
  if (process.env.PA_JOBS_DISABLED === '1') {
    console.log('[pa] 定时任务停用（PA_JOBS_DISABLED=1）')
    return () => {}
  }
  // 内存闸：状态写盘失败（saveJobState 只警告不抛）时防补跑循环——跑过的槽位内存里也记一份
  const fired = new Map<string, string>()
  const tick = async (): Promise<void> => {
    if (currentJobId) return
    const jobs = loadJobDefs(deps.dataDir)
    const state = loadJobState(deps.dataDir)
    const now = new Date()
    for (const job of jobs) {
      if (!job.text.trim()) continue
      const slot = slotToday(job, now)
      if (fired.get(job.id) === slot) continue
      const last = state[job.id]?.lastSlot
      const trigger = shouldFireNow(job, now, last) ? 'schedule' : needsCatchup(job, now, last) ? 'catchup' : null
      if (!trigger) continue
      fired.set(job.id, slot) // 先记再跑：跑挂了也不在同一槽位重试（失败已通知，下一槽位再说）
      await runJobNow(job, trigger, deps) // 状态在 runJobNow 内落盘
      break // 一 tick 一任务：错峰任务不并发烧钱，下个 tick 补上
    }
  }
  tick().catch(() => {})
  const timer = setInterval(() => tick().catch(() => {}), 20_000)
  console.log(`[pa] 定时任务调度已启动（20s 心跳 · 配置 ${path.join(deps.dataDir, JOBS_FILE)}）`)
  return () => clearInterval(timer)
}

// 进程级依赖单例（路由层和入口直接用）
export const jobDeps: JobDeps = {
  entry: MODELS.find((m) => m.id === DEFAULT_MODEL_ID) ?? MODELS[0],
  lightEntry: MODELS.find((m) => m.id === 'light'),
  allTools: tools,
  readTools: tools.filter((t) => t.risk === 'read'),
  skills,
  store,
  repo,
  dataDir: config.dataDir,
}
