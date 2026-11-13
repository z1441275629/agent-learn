// S4 时间线视图（零 token：只读 SQLite，不调模型）
// 用法：
//   node langChain/s4-timeline.ts                  # 线程总览（每 thread 的 checkpoint 数/末次时间）
//   node langChain/s4-timeline.ts <threadId>        # 单线程时间线（API 解码：step/next/消息预览）
//   node langChain/s4-timeline.ts tree              # 跨线程血缘树（ASCII）——分叉结构一目了然
//   node langChain/s4-timeline.ts tree --mermaid    # 同一棵树出 mermaid（粘进 .md 用扩展预览）
//
// 数据通路：单线明细走 graph API（getStateHistory 解码好的 BaseMessage）；跨线程树直读
// checkpoints 表的 parent_checkpoint_id——fork 的血缘是跨 thread 的（新线程首节点的 parent
// 指向源线程的 checkpoint），API 按 thread 查看不见这个结构，SQL 才是全图。
// 对照：这就是「执行层快照」的数据库形态——每 superstep 一行，parent 链就是时间线本身
import 'dotenv/config'
import { createAgent } from 'langchain'
import { ChatOpenAI } from '@langchain/openai'
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite'
import Database from 'better-sqlite3'

const DB_PATH = 'langChain/.s4-data/checkpoints.db'
const db = new Database(DB_PATH)
const checkpointer = new SqliteSaver(db)
const env = process.env
// 只为建 agent 拿 getStateHistory，不会被调用
const agent = createAgent({
  model: new ChatOpenAI({ model: env.LLM_MODEL!, apiKey: env.LLM_API_KEY!, configuration: { baseURL: env.LLM_BASE_URL! } }),
  checkpointer,
})

// id 前 8 位是时间戳前缀（同一秒内创建的 checkpoint 全撞车），取尾部 8 位才唯一
const short = (id: unknown) => String(id ?? '').replace(/-/g, '').slice(-8)

// ── 跨线程血缘树（直读 SQL：ns='' 根层，parent 链建树）──
type Row = { thread_id: string; checkpoint_id: string; parent_checkpoint_id: string | null; step: number; source: string; ts: string }
const loadRows = (): Row[] =>
  (
    db
      .prepare(
        `SELECT thread_id, checkpoint_id, parent_checkpoint_id, metadata
         FROM checkpoints WHERE checkpoint_ns='' ORDER BY rowid ASC`,
      )
      .all() as any[]
  )
    .map((r) => {
      const m = JSON.parse(r.metadata ?? '{}')
      return {
        thread_id: r.thread_id,
        checkpoint_id: r.checkpoint_id,
        parent_checkpoint_id: r.parent_checkpoint_id,
        step: m.step ?? -1,
        source: m.source ?? '?',
        ts: m.writes ? '' : '',
      }
    })
    // 同 id 多行（input 先行/loop 覆盖）按首次出现去重
    .filter((r, i, arr) => arr.findIndex((x) => x.thread_id === r.thread_id && x.checkpoint_id === r.checkpoint_id) === i)

function renderTree() {
  const rows = loadRows()
  const byId = new Map<string, Row>()
  for (const r of rows) byId.set(`${r.thread_id}#${r.checkpoint_id}`, r)
  const idOf = (r: Row) => `${r.thread_id}#${r.checkpoint_id}`
  // 子节点表：parent 在表里才挂（parent 指向别的 thread = fork 接管点）
  const children = new Map<string, Row[]>()
  const roots: Row[] = []
  for (const r of rows) {
    const parent = r.parent_checkpoint_id ? byId.get(`${r.thread_id}#${r.parent_checkpoint_id}`) : null
    const crossThreadParent = !parent && r.parent_checkpoint_id
      ? [...byId.values()].find((x) => x.checkpoint_id === r.parent_checkpoint_id)
      : null
    const key = parent ? idOf(parent) : crossThreadParent ? idOf(crossThreadParent) : null
    if (key) {
      if (!children.has(key)) children.set(key, [])
      children.get(key)!.push(r)
    } else roots.push(r)
  }

  const walk = (r: Row, prefix: string, isLast: boolean, isRoot: boolean) => {
    const branch = isRoot ? '' : isLast ? '└─ ' : '├─ '
    const label = `${r.thread_id}#${short(r.checkpoint_id)}  step=${r.step} ${r.source}`
    console.log(`${prefix}${branch}${label}`)
    const kids = children.get(idOf(r)) ?? []
    kids.forEach((k, i) => walk(k, prefix + (isRoot ? '' : isLast ? '   ' : '│  '), i === kids.length - 1, false))
  }
  console.log(`═══ checkpoint 血缘树（${rows.length} 个根层节点；跨 thread 的边 = fork 点）═══`)
  roots.forEach((r, i) => walk(r, '', i === roots.length - 1, true))

  // mermaid 版
  if (process.argv.includes('--mermaid')) {
    const threads = [...new Set(rows.map((r) => r.thread_id))]
    const palette = ['#e1f5fe', '#fff3e0', '#e8f5e9', '#fce4ec', '#f3e5f5']
    console.log('\n```mermaid')
    console.log('flowchart TD')
    threads.forEach((t, i) => console.log(`classDef t${i} fill:${palette[i % palette.length]}`))
    const node = (r: Row) => `${r.thread_id.replace(/[^a-z0-9]/gi, '_')}_${short(r.checkpoint_id)}["${r.thread_id}#${short(r.checkpoint_id)}<br/>step ${r.step} ${r.source}"]`
    const seen = new Set<string>()
    for (const r of rows) {
      const n = node(r)
      if (!seen.has(n)) {
        console.log(`  ${n}:::t${threads.indexOf(r.thread_id)}`)
        seen.add(n)
      }
    }
    for (const r of rows) {
      const p = r.parent_checkpoint_id
      if (!p) continue
      const parentRow = byId.get(`${r.thread_id}#${p}`) ?? [...byId.values()].find((x) => x.checkpoint_id === p)
      if (parentRow) console.log(`  ${node(parentRow)} --> ${node(r)}`)
    }
    console.log('```')
  }
}

// ── 线程总览 ──
function listThreads() {
  const rows = loadRows()
  const byThread = new Map<string, Row[]>()
  for (const r of rows) {
    if (!byThread.has(r.thread_id)) byThread.set(r.thread_id, [])
    byThread.get(r.thread_id)!.push(r)
  }
  console.log('═══ threads ═══')
  for (const [t, rs] of byThread)
    console.log(`  ${t.padEnd(14)} ${String(rs.length).padStart(3)} 个 checkpoint   step ${Math.min(...rs.map((r) => r.step))} → ${Math.max(...rs.map((r) => r.step))}`)
  console.log('\n看单线：node langChain/s4-timeline.ts <threadId> ；看分叉树：node langChain/s4-timeline.ts tree')
}

// ── 单线程时间线（API 解码，含消息预览）──
async function timeline(threadId: string) {
  const snaps: any[] = []
  for await (const s of agent.getStateHistory({ configurable: { thread_id: threadId } })) snaps.push(s)
  snaps.reverse() // API 新→旧，倒成旧→新
  console.log(`═══ ${threadId} 时间线（${snaps.length} 个 checkpoint，旧→新）═══`)
  for (const s of snaps) {
    const msgs: any[] = s.values?.messages ?? []
    const last = msgs.at(-1)
    const tc = last?.tool_calls?.[0]
    const preview = tc
      ? `ai⟶tool: ${tc.name}(${JSON.stringify(tc.args ?? {}).replace(/"/g, '').slice(0, 30)})`
      : last
        ? `${last.getType?.() ?? last._getType?.()}: ${String(last.content).replace(/\n/g, ' ').slice(0, 36)}`
        : '(空)'
    console.log(`  step ${String(s.metadata?.step ?? '?').padStart(3)}  ${String(s.metadata?.source ?? '?').padEnd(7)} next=${JSON.stringify(s.next ?? []).padEnd(16)} msgs=${String(msgs.length).padStart(2)}  ${preview}  · ${short(s.config?.configurable?.checkpoint_id)}`)
  }
}

const arg = process.argv[2]
if (arg === 'tree') renderTree()
else if (arg) await timeline(arg)
else listThreads()
