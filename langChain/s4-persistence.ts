// S4 持久化 + 时间旅行（OUTLINE §3 S4——手写完全没造过的，面试最大增量）
// 三模式跨进程验收：① 默认跑 part1（建历史 + Store 跨 thread 演示）
//   ② `node langChain/s4-persistence.ts continue`（新进程同 DB 续聊——杀进程重启验收）
//   ③ `node langChain/s4-persistence.ts fork`（getStateHistory 选中间 checkpoint + 新 thread_id 分叉第二条线）
// 重置（重新从零演）：删 langChain/.s4-data/ 目录
//
// 对照 personal-agent（跑完复盘落结论）：
// - checkpointer = 执行层快照：每 superstep 存全量 channels，用途是恢复/重放/分叉；
//   pa 的 sessions 账本 = 业务层快照：轮级、按需、用途是审计回看——粒度和用途都不同
// - Store vs thread state：thread 互相隔离、Store 跨 thread 共享；InMemoryStore 进程即失
//   （continue 模式里它真就蒸发了——正好实证生命周期），生产要持久化实现，对照 pa memories.ts 自己落盘
// - wrapModelCall 注入 store 记忆 = pa 记忆注入同构：只改本次模型请求的副本，不写进 thread 的 messages
//   （注入是 ephemeral 的，会话历史保持干净）
// - checkpoint_id + 新 thread_id = 分叉（时间旅行）；同 thread_id + checkpoint_id = 回滚重放
//
// 环境坑（Windows/node24 实录）：@langchain/langgraph-checkpoint-sqlite 锁 better-sqlite3@^12（node 24 无预编译，
// gyp 源码编无工具链必炸）；根装 better-sqlite3@13 有预编译能跑。若 npm install 后
// node_modules/@langchain/langgraph-checkpoint-sqlite/node_modules 又出现 12.x 嵌套副本（二进制缺失），
// 删掉该嵌套目录即可——模块解析会落回根的 13（package.json overrides 已尝试钉，lockfile 旧解析偶尔不听话）
import 'dotenv/config'
import { createAgent, createMiddleware, HumanMessage, SystemMessage } from 'langchain'
import { ChatOpenAI } from '@langchain/openai'
import { InMemoryStore } from '@langchain/langgraph'
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite'
import Database from 'better-sqlite3'
import * as fs from 'node:fs'
import * as z from 'zod'

const env = process.env
const llm = new ChatOpenAI({
  model: env.LLM_MODEL!,
  apiKey: env.LLM_API_KEY!,
  configuration: { baseURL: env.LLM_BASE_URL! },
})

// ── checkpointer：SQLite 落盘（进程死了状态还在）；构造器直收根 better-sqlite3 的 Database ──
fs.mkdirSync('langChain/.s4-data', { recursive: true })
const db = new Database('langChain/.s4-data/checkpoints.db')
const checkpointer = new SqliteSaver(db)

// ── Store：跨 thread 长期记忆（InMemory 实现——生命周期教学点：进程即失）──
const store = new InMemoryStore()

// ── 记忆注入 middleware：wrapModelCall 里读 store，注入进「本次请求的副本」——不落 thread state ──
const storeMemoryMiddleware = createMiddleware({
  name: 'store-memory',
  wrapModelCall: async (request: any, handler: any) => {
    const hits = await request.runtime?.store?.search(['memories', 'user'])
    const memory = hits?.items?.map((i: any) => JSON.stringify(i.value)).join('；')
    if (!memory) return handler(request) // store 空就原样放行（continue 模式里走这条）
    // 注入到请求副本：模型看得见，但 thread 的 messages 不受污染（对照 pa 记忆注入）
    return handler({
      ...request,
      messages: [...request.messages, new SystemMessage(`[长期记忆] ${memory}`)],
    })
  },
})

// 每个模式各自 buildAgent()：新实例 + 同一 DB 文件——「进程重启」的等价物，代码里不共享任何内存状态
const buildAgent = () =>
  createAgent({
    model: llm,
    systemPrompt: '你是个简洁的助手，回答保持一两句话。',
    checkpointer,
    store,
    middleware: [storeMemoryMiddleware],
  })

const ask = async (agent: any, threadId: string, text: string) => {
  const r = await agent.invoke({ messages: [new HumanMessage(text)] }, { configurable: { thread_id: threadId } })
  const out = String(r.messages.at(-1)?.content)
  console.log(`  [${threadId}] 问：${text}\n  [${threadId}] 答：${out}`)
  return out
}

const mode = process.argv[2] ?? 'part1'

// ═══ 模式① part1：建两轮历史 + Store 跨 thread 共享演示 ═══
if (mode === 'part1') {
  console.log('═══ S4 part1：thread 建历史 + Store 跨 thread ═══')
  const agent = buildAgent()
  // 先往 Store 放一条用户画像（对照 pa memories.ts 的记忆写入）
  await store.put(['memories', 'user'], 'profile', { name: '小明', likes: 'Rust' })
  console.log('[store.put] profile = { name: 小明, likes: Rust }')

  await ask(agent, 's4-demo', '我叫小明，最喜欢 Rust 语言。')
  await ask(agent, 's4-demo', '我刚才说我最喜欢什么？') // ← thread state 里的记忆（SQLite 已落盘）

  // 换 thread：thread state 是空的（隔离），但 store 注入让模型仍知道用户是谁
  await ask(agent, 's4-other', '你知道我是谁、喜欢什么吗？') // ← 全靠 store，不靠 thread
  console.log('\n[结论] s4-demo 的历史在 SQLite 里；s4-other 答得出靠的是 Store（跨 thread 共享）+ wrapModelCall 注入')
}

// ═══ 模式② continue：新进程、新实例、同 DB——杀进程重启续聊（验收①）═══
if (mode === 'continue') {
  console.log('═══ S4 continue：新进程恢复（状态全部来自 SQLite）═══')
  const agent = buildAgent() // 新实例；内存里什么都没有
  await ask(agent, 's4-demo', '我是谁？我最喜欢什么语言？') // ← 答得出 = checkpointer 从盘上恢复了 thread

  // 生命周期对照：InMemoryStore 蒸发了——thread state 恢复但 store 空
  await ask(agent, 's4-other', '你还知道我是谁吗？') // ← 答不出：store 进程即失 + thread 隔离
  console.log('\n[结论] thread state 跨进程恢复（SQLite）；Store 没跨过进程（InMemory）——两层生命周期不同')
}

// ═══ 模式③ fork：时间旅行——从历史 checkpoint 分叉第二条线（验收②）═══
if (mode === 'fork') {
  console.log('═══ S4 fork：getStateHistory + checkpoint_id 分叉 ═══')
  const agent = buildAgent()

  // 历史 checkpoint 列表：每个 superstep 一条（执行层快照的粒度实证）
  const snapshots: any[] = []
  for await (const snap of agent.getStateHistory({ configurable: { thread_id: 's4-demo' } })) snapshots.push(snap)
  console.log(`[history] s4-demo 共 ${snapshots.length} 个 checkpoint（新→旧）：`)
  for (const s of snapshots)
    console.log(`   · msgs=${s.values?.messages?.length ?? 0} next=${JSON.stringify(s.next)} ckpt=${String(s.config?.configurable?.checkpoint_id).slice(0, 8)}`)

  // 选「第一轮对话后」的快照（messages 恰好 2 条：一问一答）作为分叉点
  const forkPoint = snapshots.find((s: any) => s.values?.messages?.length === 2)
  if (!forkPoint) {
    console.log('[fork] 找不到第一轮后的快照——先跑 part1 建历史')
  } else {
    const ckptId = forkPoint.config.configurable.checkpoint_id
    console.log(`\n[fork] 从 ckpt=${String(ckptId).slice(0, 8)}（第一轮后）分叉出新线程 s4-fork`)
    // 真分叉写法：新 thread_id + 源 checkpoint_id——输入被当作「那个历史时点之后的新消息」
    const r = await agent.invoke(
      { messages: [new HumanMessage('其实我改主意了，我现在最喜欢 Go。')] },
      { configurable: { thread_id: 's4-fork', checkpoint_id: ckptId } },
    )
    console.log(`  [s4-fork 从分叉点答] ${String(r.messages.at(-1)?.content).slice(0, 80)}`)
    // 两条线对比：分叉线记 Go，原线仍记 Rust
    await ask(agent, 's4-fork', '我最喜欢什么语言？')
    await ask(agent, 's4-demo', '我最喜欢什么语言？')
    console.log('\n[结论] 同一个分叉点长出两条独立时间线——原线不动，分叉线从过去重新展开（时间旅行）')
  }
}
