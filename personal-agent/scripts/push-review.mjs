#!/usr/bin/env node
// Server酱推送：把一篇 markdown 全文推到微信（sctapi.ftqq.com）——不给本机链接，离开电脑也能看。
// 两个入口共用：pa 定时任务跑完（server/jobs.ts fire-and-forget）+ Claude Code 复盘收尾（.claude/skills/learning-review）。
// 纪律抄 12-capstone/daily-brief/pipeline.ts 的 notifyServerChan：
//   - 缺 key 静默 no-op（exit 0）——通知层绝不炸调用方
//   - SCT_SENDKEY 单数 + SCT_SENDKEYS 复数（逗号/空格分隔，去重）——复用既有 .env 约定
//   - key 半敏感：日志只露前 6 位
//   - 逐 key 并行独立发送，失败不连坐；全部失败才 exit 1
// 用法：node personal-agent/scripts/push-review.mjs [--file reviews/2026-11-13.md] [--date 2026-11-13] [--title 自定义标题]
//   --date 是 --file reviews/<date>.md 的糖；相对路径按仓库根解析（脚本自定位，与 cwd 无关）。
//   标题缺省取正文第一个 `# 标题`（微信卡片标题 ≤32 字，超长截断）；desp = 整篇 markdown，超 30KB 截尾标注。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..') // personal-agent/scripts/ → 仓库根

// ---------- 参数 ----------
const argv = process.argv.slice(2)
const opt = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const pad = (n) => String(n).padStart(2, '0')
const todayLocal = () => {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const date = opt('--date') ?? todayLocal()
const relFile = opt('--file') ?? path.join('reviews', `${date}.md`)
const absFile = path.isAbsolute(relFile) ? relFile : path.join(ROOT, relFile)

let body = ''
try {
  body = fs.readFileSync(absFile, 'utf8').trim()
} catch (err) {
  console.error(`[push-review] 读不到文件：${relFile}（${err?.code ?? err?.message}）`)
  process.exit(1) // 此时还没开任何网络句柄，硬 exit 安全且必须——阻止空 body 继续往下跑
}
if (!body) {
  console.error(`[push-review] 文件是空的：${relFile}`)
  process.exit(1)
}

// ---------- 标题与截尾 ----------
const firstH1 = (body.match(/^#\s+(.+)$/m) ?? [])[1]?.trim()
const title = (opt('--title') ?? firstH1 ?? path.basename(relFile)).slice(0, 32)

const LIMIT = 30_000 // 免费版 desp 上限 32KB，留头寸；截尾标注本身也占字节
if (Buffer.byteLength(body, 'utf8') > LIMIT) {
  while (Buffer.byteLength(body, 'utf8') > LIMIT) {
    body = body.slice(0, Math.floor((body.length * LIMIT) / Buffer.byteLength(body, 'utf8')))
  }
  body += `\n\n---\n⚠ 超 30KB 已截尾，全文见仓库文件 \`${path.relative(ROOT, absFile).replace(/\\/g, '/')}\``
}

// ---------- key：process.env 优先，其次根 .env（KEY=VALUE 简单解析，不引依赖） ----------
function readEnvFile(file) {
  const out = {}
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/)
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch {
    // 没有 .env 文件不算错——process.env 可能已注入
  }
  return out
}
const env = { ...readEnvFile(path.join(ROOT, '.env')), ...process.env }
const keys = [
  ...new Set(
    `${env.SCT_SENDKEY ?? ''},${env.SCT_SENDKEYS ?? ''}`
      .split(/[\s,]+/)
      .map((k) => k.trim())
      .filter(Boolean),
  ),
]
if (keys.length === 0) {
  console.log(`[push-review] SCT_SENDKEY 未配置，跳过推送（no-op）· file=${relFile}`)
  process.exit(0)
}
const maskKey = (k) => (k.length > 6 ? `${k.slice(0, 6)}…` : k)

// ---------- 发送（逐 key 并行独立，失败不连坐） ----------
// 注意收尾一律用 process.exitCode 而不是 process.exit()：fetch/undici 的句柄还在异步关闭中，
// Windows 上立刻 exit 会撞 libuv 断言（实测 2026-11-13：消息已发出但进程崩在 async.c——消息成了日志却是失败）
async function sendToOne(key) {
  try {
    const res = await fetch(`https://sctapi.ftqq.com/${key}.send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ title, desp: body }),
      signal: AbortSignal.timeout(10_000),
    })
    const j = await res.json().catch(() => ({}))
    return j?.code === 0 ? null : `HTTP ${res.status}：${j?.message ?? '未知响应'}`
  } catch (err) {
    return err?.message ?? String(err)
  }
}
const results = await Promise.all(keys.map(async (k) => ({ k, err: await sendToOne(k) })))
const failed = results.filter((r) => r.err)
for (const r of failed) console.error(`[push-review] ${maskKey(r.k)} 推送失败：${r.err}`)
console.log(
  `[push-review] 「${title}」${Buffer.byteLength(body, 'utf8')}B · sent ${results.length - failed.length}/${results.length}` +
    (failed.length ? '（有失败，见上）' : ''),
)
process.exitCode = failed.length === results.length ? 1 : 0
