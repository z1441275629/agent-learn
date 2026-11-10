// 评估集运行器:固定任务样本(tasks.json)× 真实模型 → 任务成功率 / 工具调用成功率 /
// invalid-call 率 / 延迟 / token 成本,产出 report.md + results.json。
//
// 与回归测试的分工:回归(probe / tests/regression)用 fake client 钉死「机制的代码正确性」;
// 本评估用真实模型测「模型 + 完整工具面」的端到端任务能力——模型选没选对工具、参数对不对、
// 闭环能不能走通、答案里的事实对不对。这是简历上「任务成功率 X%」的唯一数据来源。
//
// 设计决策:
//   - 跑真实产品路径:state.ts 的工具注册表 + prepareContext 的系统提示组装(记忆注入/知识库
//     引导/技能自动加载)+ runToolLoop——不 mock 任何一层,测的就是产品本身
//   - 数据隔离:import state.ts 之前 setenv PA_DATA_DIR/PA_SKILLS_DIR(它 loadConfig 在模块顶层),
//     每次运行先清空重建种子——可复现
//   - 确认门:自动批准(write 任务测的是模型该不该调、参数对不对,不是 UI 审批)
//   - 单 agent 主路径:planner/composite 编排不在本评估范围(需另行驱动 composite.ts,列为后续)
//
// 用法(仓库根目录):node personal-agent/eval/run.ts [--filter kb] [--limit 3]

import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'

// ---------- env 隔离必须发生在任何 import state.ts 之前(它模块顶层读 env) ----------
const DATA_DIR = path.resolve(process.cwd(), 'personal-agent/eval/data')
process.env.PA_DATA_DIR = DATA_DIR
process.env.PA_SKILLS_DIR = path.join(DATA_DIR, 'skills')

const args = process.argv.slice(2)
const filter = args.includes('--filter') ? args[args.indexOf('--filter') + 1] : ''
const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : 0

// ---------- 种子数据(与 tasks.json 的期望答案一一对应,改这里要同步改那边) ----------
const SEED_KB: { name: string; text: string }[] = [
  {
    name: '设备清单.txt',
    text: '我的机械键盘是 HHKB Professional 2(无刻版),2024 年 3 月购入,价格 1299 元。显示器是 Dell U2723QE 27 寸 4K。主力笔记本是公司配的 ThinkPad。',
  },
  {
    name: '读书进度.txt',
    text: '《设计数据密集型应用》(DDIA)已读完第 3 章和第 9 章,最喜欢第 9 章的一致性哈希部分。下一本计划读《Blink》。',
  },
  {
    name: '春节旅行计划.txt',
    text: '春节去成都玩:1 月 25 日出发,2 月 1 日返回,住春熙路附近,总预算 5000 元。想去大熊猫基地和都江堰。',
  },
  {
    name: '项目备忘.txt',
    text: 'ai-agent-lab 仓库的评估集放在 personal-agent/eval 目录,任务样本 20 个,按 8 个类别组织。',
  },
]
const SEED_MEMORIES = ['用户喜欢的咖啡是拿铁', '用户的前端背景,主力语言 TypeScript', '用户在准备 Agent 开发岗位的面试']
const SEED_SKILL = `---
name: eval-protocol
description: Use when 用户说「暗号检查/执行暗号检查」——按固定协议格式回复。
triggers: 暗号检查
---

# 暗号检查协议

收到「暗号检查」请求时,必须严格按以下格式回复:

1. 回复的第一行必须是「【协议确认】」五个字,一个字都不能差
2. 第二行写今天的日期(用 get_time 工具查,不要猜)
3. 第三行写「协议执行完毕」

除这三行外不要输出任何其他内容。
`

// ---------- 本地 fixture 页面(浏览器任务的确定性靶子;JS 延迟注入那页测等待逻辑) ----------
const PAGES: Record<string, string> = {
  '/info': '<!doctype html><html><head><title>评估页·设备信息</title></head><body><h1>设备信息</h1><ul><li>ThinkPad X1 Carbon(工作机)</li><li>iPad mini 6(阅读器)</li><li>Kindle Paperwhite 4(泡面盖)</li></ul></body></html>',
  '/spa': '<!doctype html><html><head><title>评估页·延迟加载</title></head><body><h1>加载中...</h1><script>setTimeout(()=>{document.body.innerHTML="<h1>延迟加载完成标记 PINEAPPLE-77</h1><p>内容就绪</p>"},250)<\/script></body></html>',
  '/links': '<!doctype html><html><head><title>评估页·导航</title></head><body><h1>导航测试页</h1><nav><a href="/target">关于我们</a> <a href="/info">设备信息</a></nav></body></html>',
  '/target': '<!doctype html><html><head><title>关于我们·落地页</title></head><body><h1>关于我们</h1><p>本页暗号:MANGO-42</p></body></html>',
}

// ---------- 判分 ----------
interface TaskSpec {
  id: string
  category: string
  task: string
  expectTools?: string[]
  expectToolOrder?: string[]
  forbidTools?: string[]
  expectNoTools?: boolean
  answerAll?: string[]
  answerAny?: string[]
  answerMinLen?: number
  dateToday?: boolean
  stateChecks?: string[]
}
interface ToolCallRecord {
  name: string
  args: string
  result: string
  ms: number
  classification: 'ok' | 'invalid' | 'exec-error'
}
interface TaskResult {
  id: string
  category: string
  task: string
  ok: boolean
  failures: string[]
  toolsCalled: string[]
  calls: ToolCallRecord[]
  rounds: number
  wallMs: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  aborted: boolean
  answer: string
}

/** dispatch 的三类结果:正常 / 模型调用不当(未注册、参数非 JSON)/ 执行失败 */
function classifyCall(t: { name: string; result: string }): ToolCallRecord['classification'] {
  if (t.result.includes('未注册的工具') || t.result.includes('参数不是合法 JSON')) return 'invalid'
  if (t.result.includes('工具执行失败') || t.result.includes('用户拒绝')) return 'exec-error'
  return 'ok'
}

function todayForms(): string[] {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1)
  const mm = m.padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const day = String(d.getDate())
  return [
    `${y}-${mm}-${dd}`,
    `${y}/${mm}/${dd}`,
    `${y}年${m}月${day}日`,
    `${y}年${mm}月${dd}日`,
    `${m}月${day}日`,
    `${mm}-${dd}`,
    `${m}/${day}`,
  ]
}

async function grade(
  spec: TaskSpec,
  answer: string,
  calls: ToolCallRecord[],
  stateCheck: (kind: string, arg: string) => Promise<string | null>,
): Promise<{ ok: boolean; failures: string[] }> {
  const failures: string[] = []
  const called = calls.map((c) => c.name)
  const lower = answer.toLowerCase()
  // 归一化视图:去空白/markdown 符号——模型爱写「2026 年 11 月 10 日」或加粗,关键词不能被空格骗过去
  const flat = answer.replace(/[\s*#_、,，。:：]/g, '').toLowerCase()

  if (spec.expectNoTools && calls.length > 0) failures.push(`不该调工具却调了:${called.join(',')}`)
  if (spec.expectTools) {
    for (const t of spec.expectTools) if (!called.includes(t)) failures.push(`期望调用 ${t} 但没调`)
  }
  if (spec.forbidTools) {
    for (const t of spec.forbidTools) if (called.includes(t)) failures.push(`禁止调用 ${t} 却调了`)
  }
  if (spec.expectToolOrder) {
    const watched = called.filter((n) => spec.expectToolOrder!.includes(n))
    if (JSON.stringify(watched) !== JSON.stringify(spec.expectToolOrder)) {
      failures.push(`工具顺序不符:期望 ${spec.expectToolOrder!.join('→')} 实际 ${called.join('→')}`)
    }
  }
  const has = (s: string) => lower.includes(s.toLowerCase()) || flat.includes(s.toLowerCase())
  for (const s of spec.answerAll ?? []) if (!has(s)) failures.push(`答案缺少关键词「${s}」`)
  if (spec.answerAny && !spec.answerAny.some(has)) failures.push(`答案不含任一关键词:${spec.answerAny.join('/')}`)
  if (spec.answerMinLen && answer.trim().length < spec.answerMinLen) failures.push(`答案过短(${answer.trim().length} 字)`)
  if (spec.dateToday && !todayForms().some((f) => flat.includes(f.replace(/[\s、]/g, ''))))
    failures.push(`答案不含今天日期(${todayForms()[0]})`)

  // invalid 调用本身即失败信号(模型选错工具/给坏参数,哪怕最终答案蒙对了)
  const invalid = calls.filter((c) => c.classification === 'invalid')
  if (invalid.length) failures.push(`invalid 调用 ×${invalid.length}:${invalid.map((c) => c.name).join(',')}`)

  // 状态后检(记忆/知识库落盘验证)全部异步执行
  const stateErrs = await Promise.all(
    (spec.stateChecks ?? []).map(async (raw) => {
      const i = raw.indexOf(':')
      const kind = i === -1 ? raw : raw.slice(0, i)
      const arg = i === -1 ? '' : raw.slice(i + 1)
      return stateCheck(kind, arg)
    }),
  )
  for (const e of stateErrs) if (e) failures.push(e)
  return { ok: failures.length === 0, failures }
}

function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}
function pct(xs: number[], p: number): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((s.length * p) / 100))]
}

// ---------- 主流程 ----------
async function main() {
  // 种子技能文件要先落盘(skills store 在 import 时扫目录)
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
  fs.mkdirSync(path.join(DATA_DIR, 'skills'), { recursive: true })
  fs.writeFileSync(path.join(DATA_DIR, 'skills', 'eval-protocol.md'), SEED_SKILL)

  const { tools, memories, kb, browser } = await import('../server/state.ts')
  const { prepareContext } = await import('../server/chat-service.ts')
  const { runToolLoop } = await import('../core/agent.ts')
  const { MODELS, thinkingParams } = await import('../models.ts')
  type SessionDocT = import('../core/sessions.ts').SessionDoc

  const entry = MODELS[0]
  if (!entry) throw new Error('MODELS 为空——检查 .env 的 LLM_* 配置')

  // 种子:知识库 + 记忆
  for (const doc of SEED_KB) await kb.add(doc.name, doc.text)
  const now = new Date().toISOString()
  await memories.save(
    SEED_MEMORIES.map((text, i) => ({ id: `seed-${i + 1}`, text, createdAt: now, updatedAt: now })),
  )
  console.log(`[eval] 种子就绪:KB ${SEED_KB.length} 篇 / 记忆 ${SEED_MEMORIES.length} 条 / 技能 1 个(eval-protocol)`)

  // fixture 服务器
  const server = http.createServer((req, res) => {
    const page = PAGES[req.url ?? '/']
    if (page) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(page)
    } else {
      res.writeHead(404)
      res.end('not found')
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  const origin = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  console.log(`[eval] fixture 服务器:${origin}`)

  const allTasks: TaskSpec[] = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'tasks.json'), 'utf8')).tasks
  let tasks = filter ? allTasks.filter((t) => t.id.includes(filter) || t.category.includes(filter)) : allTasks
  if (limit > 0) tasks = tasks.slice(0, limit)
  console.log(`[eval] 模型 ${entry.model} · 任务 ${tasks.length}/${allTasks.length} 个(单 agent 主路径,确认门自动批准)\n`)

  const results: TaskResult[] = []
  for (let i = 0; i < tasks.length; i++) {
    const spec = tasks[i]
    const taskText = spec.task.replaceAll('{origin}', origin)
    const t0 = Date.now()
    process.stdout.write(`[${i + 1}/${tasks.length}] ${spec.id} `)

    // 伪造最小会话文档,走 prepareContext 的真实组装(记忆注入/KB 引导/技能自动加载)
    const doc: SessionDocT = {
      id: `eval-${spec.id}-${Date.now().toString(36)}`,
      title: spec.id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [
        {
          id: 1,
          role: 'user',
          text: taskText,
          images: [],
          createdAt: new Date().toISOString(),
        },
      ],
    }
    let result: TaskResult = {
      id: spec.id,
      category: spec.category,
      task: taskText,
      ok: false,
      failures: ['任务异常'],
      toolsCalled: [],
      calls: [],
      rounds: 0,
      wallMs: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      aborted: false,
      answer: '',
    }
    try {
      const messages = await prepareContext(doc, entry, false, null, true)
      const loop = await Promise.race([
        runToolLoop(entry.client, entry.model, messages, {
          tools,
          maxRounds: 5,
          maxResultChars: 9000,
          extraBody: thinkingParams('off'),
          onConfirm: async () => true, // 评估:门自动批准,测模型不测 UI
          signal: AbortSignal.timeout(180_000),
        }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('任务总超时 200s')), 200_000)),
      ])
      const calls: ToolCallRecord[] = loop.trace.map((t) => ({
        name: t.name,
        args: t.args,
        result: t.result,
        ms: t.ms,
        classification: classifyCall(t),
      }))
      const usage = loop.usage ?? {}
      result = {
        id: spec.id,
        category: spec.category,
        task: taskText,
        ok: false,
        failures: [],
        toolsCalled: calls.map((c) => c.name),
        calls,
        rounds: loop.rounds,
        wallMs: Date.now() - t0,
        promptTokens: usage.prompt_tokens ?? 0,
        completionTokens: usage.completion_tokens ?? 0,
        totalTokens: usage.total_tokens ?? 0,
        aborted: loop.aborted,
        answer: loop.text,
      }
      // 状态后检(记忆/知识库落盘验证)
      const stateCheck = async (kind: string, arg: string): Promise<string | null> => {
        if (kind === 'memoryContains') {
          const entries = await memories.list()
          return entries.some((e) => e.text.includes(arg)) ? null : `记忆里没找到「${arg}」`
        }
        if (kind === 'memoryNotContains') {
          const entries = await memories.list()
          return entries.some((e) => e.text.includes(arg)) ? `记忆里仍存在「${arg}」(应已删除)` : null
        }
        if (kind === 'kbHit') {
          const hits = await kb.search(arg, 3, { chatterGate: false })
          return hits.length > 0 ? null : `知识库检索「${arg}」无命中(应已写入)`
        }
        return `未知 stateCheck:${kind}`
      }
      const g = await grade(spec, loop.text, calls, stateCheck)
      result.ok = g.ok && !loop.aborted
      result.failures = g.failures
      if (loop.aborted) result.failures.push('被中止(超时?)')
    } catch (err: any) {
      result.failures = [`运行异常:${err?.message ?? err}`]
      result.wallMs = Date.now() - t0
    }
    results.push(result)
    const mark = result.ok ? '✓' : '✗'
    console.log(
      `${mark} ${(result.wallMs / 1000).toFixed(1)}s · ${result.totalTokens}tk · 工具[${result.toolsCalled.join(',') || '无'}]` +
        (result.ok ? '' : ` · ${result.failures.join(';')}`),
    )
  }

  // ---------- 汇总 ----------
  const totalCalls = results.flatMap((r) => r.calls)
  const okCalls = totalCalls.filter((c) => c.classification === 'ok').length
  const invalidCalls = totalCalls.filter((c) => c.classification === 'invalid').length
  const execErrors = totalCalls.filter((c) => c.classification === 'exec-error').length
  const passed = results.filter((r) => r.ok).length
  const walls = results.map((r) => r.wallMs)
  const sums = {
    prompt: results.reduce((a, r) => a + r.promptTokens, 0),
    completion: results.reduce((a, r) => a + r.completionTokens, 0),
    total: results.reduce((a, r) => a + r.totalTokens, 0),
  }
  const categories = [...new Set(results.map((r) => r.category))]
  const byCat = categories.map((c) => {
    const rs = results.filter((r) => r.category === c)
    return { category: c, pass: rs.filter((r) => r.ok).length, total: rs.length }
  })

  const metrics = {
    model: entry.model,
    date: new Date().toISOString(),
    taskTotal: results.length,
    taskPassed: passed,
    taskSuccessRate: +(passed / results.length).toFixed(3),
    toolCallTotal: totalCalls.length,
    toolCallOk: okCalls,
    toolCallSuccessRate: totalCalls.length ? +(okCalls / totalCalls.length).toFixed(3) : null,
    invalidCallRate: totalCalls.length ? +(invalidCalls / totalCalls.length).toFixed(3) : null,
    execErrorCount: execErrors,
    latencyMeanMs: Math.round(walls.reduce((a, b) => a + b, 0) / (walls.length || 1)),
    latencyMedianMs: median(walls),
    latencyP95Ms: pct(walls, 95),
    tokens: { ...sums, meanPerTask: Math.round(sums.total / (results.length || 1)) },
    byCategory: byCat,
  }

  // report.md(简历证据)+ results.json(全量明细,复跑对比用)
  const lines: string[] = [
    `# personal-agent 评估报告`,
    ``,
    `- 模型:\`${entry.model}\`(主档,thinking off)· 运行:${metrics.date}`,
    `- 范围:单 agent 主路径(工具循环 + 记忆注入 + KB 引导 + 技能自动加载),确认门自动批准;编排(composite/planner)不在本版范围`,
    `- 注意:真实模型单次运行,结果受随机性影响;判分标准见 \`tasks.json\`,复跑对比看 \`results.json\``,
    ``,
    `## 总指标`,
    ``,
    `| 指标 | 值 |`,
    `| --- | --- |`,
    `| 任务成功率 | **${passed}/${results.length}(${(metrics.taskSuccessRate * 100).toFixed(0)}%)** |`,
    `| 工具调用成功率 | ${okCalls}/${totalCalls.length}(${((metrics.toolCallSuccessRate ?? 0) * 100).toFixed(0)}%) |`,
    `| invalid-call 率 | ${(metrics.invalidCallRate! * 100).toFixed(1)}%(模型调错工具/坏参数) |`,
    `| 执行失败数 | ${execErrors} |`,
    `| 延迟 | 均值 ${(metrics.latencyMeanMs / 1000).toFixed(1)}s / 中位 ${(metrics.latencyMedianMs / 1000).toFixed(1)}s / P95 ${(metrics.latencyP95Ms / 1000).toFixed(1)}s |`,
    `| token 成本 | 共 ${sums.total}(prompt ${sums.prompt} + completion ${sums.completion}),均值 ${metrics.tokens.meanPerTask}/任务 |`,
    ``,
    `## 分类明细`,
    ``,
    `| 类别 | 通过 | 任务 |`,
    `| --- | --- | --- |`,
    ...byCat.map((c) => `| ${c.category} | ${c.pass}/${c.total} | ${results.filter((r) => r.category === c.category).map((r) => (r.ok ? '✓' : '✗') + r.id).join(' ')} |`),
    ``,
    `## 未通过任务`,
    ``,
    ...(results.filter((r) => !r.ok).length
      ? results.filter((r) => !r.ok).map((r) => `- **${r.id}**:${r.failures.join(';')}\n  > 任务:${r.task}\n  > 工具:[${r.toolsCalled.join(',')}]\n  > 答案前 200 字:${r.answer.slice(0, 200)}`)
      : ['(无)']),
  ]
  fs.writeFileSync(path.join(import.meta.dirname, 'report.md'), lines.join('\n'))
  fs.writeFileSync(
    path.join(import.meta.dirname, 'results.json'),
    JSON.stringify({ metrics, results }, null, 2),
  )

  console.log(`\n[eval] 完成:${passed}/${results.length} 通过 · 工具调用 ${okCalls}/${totalCalls.length} · invalid ${invalidCalls}`)
  console.log(`[eval] 延迟 均值${(metrics.latencyMeanMs / 1000).toFixed(1)}s 中位${(metrics.latencyMedianMs / 1000).toFixed(1)}s · token 共 ${sums.total}`)
  console.log(`[eval] 报告:personal-agent/eval/report.md`)

  await new Promise<void>((r) => server.close(() => r()))
  if (browser) await browser.close().catch(() => {})
}

main().catch((err) => {
  console.error('[eval] 致命错误:', err)
  process.exit(1)
})
