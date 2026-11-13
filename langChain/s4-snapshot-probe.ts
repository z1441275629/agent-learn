// S4 探针③：快照污染——原地改 reducer 会不会篡改 checkpointer 里的历史快照（零 token，纯函数节点）
// 跑法：node langChain/s4-snapshot-probe.ts
//
// 四个组合各跑 3 步（计数 hits: 1→2→3），再看 getStateHistory 里每一步的快照值：
//   历史 = {1,2,3}（各时点值）→ 没污染；历史 = {3,3,3}（全最终值）→ 引用共享，历史被篡改
//
// ★ 实验定论（2026-11-13，本文件跑出）：四组合全部历史完好 [_,_,1, 1,1,2, 2,2,3]——臆断被证伪。
// 机制（MemorySaver put() 源码实证，memory.js:219）：它不存对象引用！put 时走 serde.dumpsTyped
// 序列化成 JSON 字符串、getTuple 再 loadsTyped 反序列化出【新对象】——与 SqliteSaver 同一条 serde
// 通路，只是落 Map 不落盘。每个 checkpoint 写入那一刻就冻结成字节拷贝，原地改 reducer 改的是
// 「活的 channel 对象」，碰不到已序列化的历史 → s1 的原地改 reducer 不污染历史快照。
// 但注意：这是实现细节不是契约——纯函数 reducer 仍是正确写法（换 saver 实现/语言版本不保证）。
import { StateGraph, StateSchema, ReducedValue, MemorySaver, START, END } from '@langchain/langgraph'
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite'
import Database from 'better-sqlite3'
import * as z from 'zod'

// 两种 reducer：原地改（s1 同款）vs 纯函数（拷贝后改）
const mutating = (prev: any, next: any) => {
  for (const [k, v] of Object.entries(next)) prev[k] = (prev[k] ?? 0) + v
  return prev // ← 返回的还是传入的同一个对象
}
const pure = (prev: any, next: any) => {
  const out = { ...prev }
  for (const [k, v] of Object.entries(next)) out[k] = (out[k] ?? 0) + v
  return out // ← 新对象
}

const makeGraph = (reducer: (a: any, b: any) => any, checkpointer: any) =>
  new StateGraph(
    new StateSchema({
      tally: new ReducedValue(z.record(z.string(), z.number()).default(() => ({})), { reducer }),
    }),
  )
    .addNode('add', () => ({ tally: { hits: 1 } })) // 每步写增量，reducer 负责累加
    .addEdge(START, 'add')
    .addEdge('add', END)
    .compile({ checkpointer })

async function run(label: string, reducer: (a: any, b: any) => any, checkpointer: any) {
  const g = makeGraph(reducer, checkpointer)
  const thread = { configurable: { thread_id: `probe-${label}` } }
  for (let i = 1; i <= 3; i++) await g.invoke({}, thread)
  const history: any[] = []
  for await (const snap of g.getStateHistory(thread)) history.push(snap.values?.tally?.hits)
  history.reverse() // 旧→新
  const polluted = history.filter((h) => h !== undefined).every((h) => h === 3)
  console.log(`${label.padEnd(28)} 历史快照值(旧→新) = [${history.join(', ')}]  ${polluted ? '⚠️ 全是最终值——历史被污染' : '✓ 各时点值——历史完好'}`)
}

console.log('═══ 快照污染探针：3 步计数后回看历史 ═══')
await run('原地改 × MemorySaver', mutating, new MemorySaver())
await run('纯函数 × MemorySaver', pure, new MemorySaver())
await run('原地改 × SQLite', mutating, new SqliteSaver(new Database(':memory:')))
await run('纯函数 × SQLite', pure, new SqliteSaver(new Database(':memory:')))
