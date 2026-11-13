// 模块 16 第三层·定时任务（纯逻辑）：任务定义/状态 IO + 触发判定 + 无头确认门。
// 与 server/jobs.ts 分开：这里不 import 任何带状态的单例（store/models），探针可零成本 import。
// cron 语义刻意收窄成「每天 HH:MM，可选星期几」——个人工作台的定时任务不需要 5 段 cron 表达式，
// 收窄换来的可读性和 jobs.json 手改安全性更值钱。

import fs from 'node:fs'
import path from 'node:path'

/** 一个定时任务：到点把 text 当一条用户消息跑一遍（路由三态照常分流），产出落成会话 */
export interface JobDef {
  id: string
  name: string
  /** 关了就不触发（配置文件在手，这个开关管「今天还跑不跑」而不是删任务） */
  enabled: boolean
  hour: number
  minute: number
  /** 触发的星期（0=周日…6=周六），缺省=每天 */
  days?: number[]
  /** 到点执行的用户消息文本（如「复盘今天的学习内容」） */
  text: string
  /**
   * 无头运行自动放行的写入类工具名。定时任务没人守着点确认卡——不在清单里的 write 工具
   * *直接拒绝*（fail closed，拒绝会记进会话让人看到），而不是挂 2 分钟等超时
   */
  allow: string[]
  /**
   * 任务成功跑完后把这个文件推到微信（Server酱 全文，scripts/push-review.mjs）。相对路径按仓库根解析；
   * '{{date}}' 替换成当天 YYYY-MM-DD（复盘文件名跟日期走）。缺省不推；.env 缺 SCT_SENDKEY 时脚本静默 no-op
   */
  pushFile?: string
}

/** 任务运行状态（data/jobs-state.json）：防重启重触发 + 补跑判定 + 面板展示 */
export interface JobStateEntry {
  /** 上次运行完成时刻（ISO） */
  lastRunAt: string
  /** 上次跑的是哪个槽位 'YYYY-MM-DD HH:MM'（按任务的计划时刻记，不是实际开跑时刻——手动跑也算消耗当天槽位） */
  lastSlot: string
  /** 人话状态：done · 12.3k tokens · 412s / error: … */
  lastStatus: string
  lastSessionId?: string
  lastTokens?: number
}

export const JOBS_FILE = 'jobs.json'
export const JOBS_STATE_FILE = 'jobs-state.json'

/** 新装模板：文件不存在时写一份（disabled——要跑把 enabled 改 true 或调 toggle 接口） */
export const EXAMPLE_JOBS: JobDef[] = [
  {
    id: 'daily-review',
    name: '每日学习复盘',
    enabled: false,
    hour: 21,
    minute: 0,
    text: '复盘今天的学习内容',
    allow: ['write_file', 'add_note'],
  },
]

// ---------- 触发判定（纯函数，探针主对象） ----------

const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** 任务在今天对应的槽位键 'YYYY-MM-DD HH:MM'（日期取 now 的——跨天自然翻篇） */
export function slotToday(job: Pick<JobDef, 'hour' | 'minute'>, now: Date): string {
  return `${ymd(now)} ${pad(job.hour)}:${pad(job.minute)}`
}

function dayMatches(job: JobDef, now: Date): boolean {
  const days = job.days ?? [0, 1, 2, 3, 4, 5, 6]
  return days.includes(now.getDay())
}

/** 到点触发：当前分钟 == 计划分钟，且这个槽位今天没跑过（lastSlot 去重，20s 多次 tick 只发一次） */
export function shouldFireNow(job: JobDef, now: Date, lastSlot: string | undefined): boolean {
  if (!job.enabled || !dayMatches(job, now)) return false
  if (now.getHours() !== job.hour || now.getMinutes() !== job.minute) return false
  return slotToday(job, now) !== lastSlot
}

/**
 * 补跑判定：今天的计划时刻已过、但今天的槽位没被消耗过（服务没开机/刚启用）→ 启动时补一次。
 * 只补当天——昨天的坑不填（复盘补昨天的意义看场景，宁可少跑不偷偷多烧钱）。
 */
export function needsCatchup(job: JobDef, now: Date, lastSlot: string | undefined): boolean {
  if (!job.enabled || !dayMatches(job, now)) return false
  if (lastSlot && lastSlot.slice(0, 10) === ymd(now)) return false
  return now.getHours() > job.hour || (now.getHours() === job.hour && now.getMinutes() >= job.minute)
}

// ---------- 无头确认门 ----------

/**
 * 定时任务的 onConfirm：allow 清单内的 write 工具直接放行，清单外当场拒绝（fail closed——
 * 「没人应答」对工具就是「不行」，和 SSE 门的超时语义一致，但不白等 2 分钟）。
 * 拒绝记录进 deniedLog，运行收尾时附进会话让人看见缺了什么。
 */
export function makeHeadlessConfirm(allow: string[], deniedLog: string[]): (req: { name: string }) => Promise<boolean> {
  return async (req) => {
    if (allow.includes(req.name)) return true
    if (!deniedLog.includes(req.name)) deniedLog.push(req.name)
    return false
  }
}

// ---------- 配置 / 状态 IO（目录参数化，测试指向临时目录） ----------

/** 宽容解析+校验：坏字段丢弃不炸（配置文件是手改的，一个手误不该停掉全部任务），非法项打警告 */
export function normalizeJobDef(raw: any, warn: (msg: string) => void): JobDef | null {
  if (!raw || typeof raw.id !== 'string' || !raw.id.trim()) {
    warn(`任务缺 id，跳过：${JSON.stringify(raw).slice(0, 60)}`)
    return null
  }
  const hour = Number(raw.hour)
  const minute = Number(raw.minute)
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    warn(`任务 ${raw.id} 的 hour/minute 非法（${raw.hour}:${raw.minute}），视为停用`)
    return null
  }
  const days = Array.isArray(raw.days)
    ? (raw.days as any[]).map(Number).filter((d: number) => Number.isInteger(d) && d >= 0 && d <= 6)
    : undefined
  return {
    id: raw.id.trim(),
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : raw.id,
    enabled: raw.enabled === true,
    hour,
    minute,
    ...(days && days.length ? { days } : {}),
    text: typeof raw.text === 'string' ? raw.text : '',
    allow: Array.isArray(raw.allow) ? raw.allow.filter((a: any) => typeof a === 'string') : [],
    ...(typeof raw.pushFile === 'string' && raw.pushFile.trim() ? { pushFile: raw.pushFile.trim() } : {}),
  }
}

/** 读 jobs.json；文件不存在 → 写入模板并返回模板（首装自举，用户拿到的是可改的样例） */
export function loadJobDefs(dir: string, warn: (msg: string) => void = console.warn): JobDef[] {
  const file = path.join(dir, JOBS_FILE)
  let parsed: any
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ jobs: EXAMPLE_JOBS }, null, 2) + '\n', 'utf8')
      warn(`[pa] 没有任务配置，已写入模板：${file}（默认停用，改 enabled 或调 /api/jobs 开）`)
    } catch (err: any) {
      warn(`[pa] 任务配置写不进去（${err?.message}）——定时任务不启动`)
    }
    return EXAMPLE_JOBS.map((j) => ({ ...j }))
  }
  const list = Array.isArray(parsed?.jobs) ? parsed.jobs : []
  const jobs = list.map((j: any) => normalizeJobDef(j, warn)).filter((j: JobDef | null): j is JobDef => !!j)
  return jobs
}

export function saveJobDefs(dir: string, jobs: JobDef[]): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, JOBS_FILE), JSON.stringify({ jobs }, null, 2) + '\n', 'utf8')
}

export function loadJobState(dir: string): Record<string, JobStateEntry> {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, JOBS_STATE_FILE), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function saveJobState(dir: string, state: Record<string, JobStateEntry>): void {
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, JOBS_STATE_FILE), JSON.stringify(state, null, 2) + '\n', 'utf8')
  } catch (err: any) {
    // 状态写失败只降级（重启后可能重触发一次当天任务），不阻断任务本身
    console.warn(`[pa] 任务状态写盘失败（忽略，重启后可能重跑当天任务）：${err?.message}`)
  }
}
