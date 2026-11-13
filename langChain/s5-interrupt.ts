// S5 interrupt HITL（OUTLINE §3 S5 快站——图内原生 interrupt() 原语）
// 场景：敏感写入审批——写档案库前必须人批。零 token：纯函数节点，不调模型。
// 跑法（顺序：run → approve 或 reject → 只有 approve 线需要 confirm）：
//   node langChain/s5-interrupt.ts            # 建线程跑到审批闸，打印 __interrupt__（暂停点信息）
//   node langChain/s5-interrupt.ts approve     # 新进程 Command resume 'approve' → 放行，停在金额二次确认闸
//   node langChain/s5-interrupt.ts confirm    # resume 'confirm' → 写入完成（approve 线的最后一步）
//   node langChain/s5-interrupt.ts reject     # resume 'reject' → 拒绝出局（从 run 后直接走）
//   删 langChain/.s5-data/ 可从零重演
//
// 本站增量（S2/S4 已抢跑的部分不重复）：
// - S2 学的是 humanInTheLoopMiddleware——声明式：配置里挂工具名，钩子自动拦
//   工具调用；本站学图内 interrupt()——命令式：任意 StateGraph 节点的任意位置
//   主动暂停，暂停条件自己写。同一个 GraphInterrupt 机制的两层皮。
// - 同节点多次 interrupt 按 resume 顺序逐个解（write 节点里的金额确认是第二个闸，
//   approve 模式走到它停下——多闸顺序实证）
// - responseSchema：Zod schema 既校验 resume 值（resume 传 'yolo' 会炸 ZodError）
//   又以 JSON Schema 暴露给客户端渲染表单——「暂停点自带类型」
// - 实证①（resume:yolo → 炸 ZodError → resume:approve）：校验失败不丢暂停点——
//   ZodError 抛在节点重执行层，checkpoint 未推进，随后拿合法值 resume 仍从原闸继续
// - 实证②（S4 异步审批同构）：getState().next 就是暂停点路标——挂在 ["review"] = review 待执行
//
// 对照 personal-agent（面试金句素材，OUTLINE 原文）：
// - 框架 interrupt 的默认语义 = 给了「暂停点 + resume 通道」，但放行策略是空的：
//   没人批时线程永远挂起——无超时、无默认拒绝、无审批日志。pa 的确认门是
//   fail-closed：无门/抛错/超时/断流一律拒绝。框架给了暂停点，放行策略还是要接入方自己定
//   ——审批的超时/兜底拒绝/审计，得像 pa 那样在接入层补，这是 interrupt() 没给你的部分。
// - API 坑（interrupt.d.ts 文档明说）：GraphInterrupt 靠 throw 传播，节点里
//   try/catch 包住 interrupt 又不 rethrow = 静默吞掉暂停——别包，包了必须原样重抛
import { StateGraph, StateSchema, ReducedValue, START, END, Command, interrupt } from '@langchain/langgraph'
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite'
import Database from 'better-sqlite3'
import * as fs from 'node:fs'
import * as z from 'zod'

// 跨进程审批要落盘（对照 S4：MemorySaver 进程即失，resume 就找不到暂停点了）
fs.mkdirSync('langChain/.s5-data', { recursive: true })
const checkpointer = new SqliteSaver(new Database('langChain/.s5-data/approvals.db'))

const THREAD = 's5-approval'
const cfg = { configurable: { thread_id: THREAD } }

// ── state：draft / decision / amount / 账本（append 语义，S1~S4 同款 ReducedValue）──
const S = new StateSchema({
  draft: z.string().default(''),
  decision: z.enum(['approve', 'reject']).default('approve'),
  record: z.string().default(''),
  ledger: new ReducedValue(z.array(z.string()).default(() => []), {
    inputSchema: z.string(),
    reducer: (cur, next) => [...cur, next],
  }),
})

// Error: draft is already being used as a state attribute (a.k.a. a channel), cannot also be used as a node name.
// ↑ 坑：节点名与 state 字段共享一个命名空间（state key 就是 channel 名，LangGraph 不允许重名）——节点改叫 prepare
// ── 图：prepare → review（闸①）→ approve? write（闸②+落笔）: 拒绝出局 ──
const graph = new StateGraph(S)
  .addNode('prepare', () => {
    console.log('[prepare] 生成待批条目：购 3 块 A100，预算 45000 元')
    return { draft: '购 3 块 A100', ledger: '[prepare] 生成条目' }
  })
  .addNode('review', (s: any) => {
    // 闸①：无 resume 值 → 抛 GraphInterrupt 暂停（invoke 结果挂在 __interrupt__）；
    // 有 resume 值 → 原样返回它。responseSchema 顺手校验：resume 'yolo' 直接 ZodError
    const decision = interrupt(
      { item: s.draft, ask: '批准写入档案库？' },
      { responseSchema: z.enum(['approve', 'reject']) },
    )
    console.log(`[review] 收到人工决定：${decision}`)
    return { decision, ledger: `[review] 人工=${decision}` }
  })
  .addNode('write', (s: any) => {
    // 闸②：同节点第二道 interrupt——approve 线走完 review 后停在这，confirm 才解
    const confirmed = interrupt(
      { amount: 45000, ask: '金额复核无误？' },
      { responseSchema: z.enum(['confirm']) },
    )
    const record = `${s.draft}（45000 元）—— 已入档案库 [${confirmed}]`
    console.log(`[write] ${record}`)
    return { record, ledger: `[write] 落笔完成` }
  })
  .addEdge(START, 'prepare')
  .addEdge('prepare', 'review')
  .addConditionalEdges('review', (s: any) => s.decision, { approve: 'write', reject: END })
  .addEdge('write', END)
  .compile({ checkpointer })

const printPaused = async (r: any) => {
  const intr = r.__interrupt__?.[0]
  if (intr) {
    console.log(`  ⏸ 暂停在 [${intr.interrupt_id ?? '?'}] value=${JSON.stringify(intr.value)}`)
    const state = await graph.getState(cfg)
    console.log(`  ⏸ getState().next = ${JSON.stringify(state.next)}  ← 下一步要执行的节点`)
  } else console.log(`  ✓ 完成：${JSON.stringify(r).slice(0, 120)}`)
}

// fail-closed 守卫（本条是 pa 对照的现场演出）：框架对「空线程上 Command resume」
// 静默空转——不报错、不启动节点、只留一个 step=-1 的空 input checkpoint、返回全 default
// 状态（实验证实：验收期忘跑 run 直接 resume:fuck，输出「✓ 完成」+ 账本空）。框架只给了
// resume 通道，不验「挂起点是否存在」——这一步像 pa 确认门一样由接入方 fail-closed 自己补
const requirePause = async (label: string) => {
  const st = await graph.getState(cfg)
  if (!st?.next?.length) {
    console.log(`  ✗ 线程 ${THREAD} 没有挂起的暂停点——resume「${label}」会被框架静默空转（只留 step=-1 空 checkpoint）`)
    console.log('  ✓ 正确顺序：先跑 node langChain/s5-interrupt.ts run 挂起，再 resume')
    process.exit(1)
  }
}

const mode = process.argv[2] ?? 'run'
if (mode === 'run') {
  console.log('═══ S5 run：跑到闸①（审批），线程挂起 ═══')
  await printPaused(await graph.invoke({}, cfg))
  console.log('\n下一步：node langChain/s5-interrupt.ts approve（或 reject）')
} else if (mode === 'approve' || mode === 'reject') {
  console.log(`═══ S5 ${mode}：新进程 resume 闸① ═══`)
  await requirePause(mode)
  await printPaused(await graph.invoke(new Command({ resume: mode }), cfg))
  if (mode === 'approve') console.log('\n下一步：node langChain/s5-interrupt.ts confirm')
} else if (mode === 'confirm') {
  console.log('═══ S5 confirm：resume 闸②，写入完成 ═══')
  await requirePause(mode)
  const r = await graph.invoke(new Command({ resume: 'confirm' }), cfg)
  console.log(`  ✓ record = ${r.record}`)
  console.log(`  账本：${JSON.stringify(r.ledger)}`)
} else if (mode.startsWith('resume:')) {
  // 透传任意 resume 值——拿它试 responseSchema 校验：node langChain/s5-interrupt.ts resume:yolo
  const val = mode.slice('resume:'.length)
  console.log(`═══ S5 resume 原始值「${val}」——responseSchema 校验实验 ═══`)
  await requirePause(val)
  await printPaused(await graph.invoke(new Command({ resume: val }), cfg))
} else console.log(`未知模式：${mode}（run | approve | reject | confirm）`)

// node .\langChain\s5-interrupt.ts resume:ohou
// $ZodError: [
//   {
//     "code": "invalid_value",
//     "values": [
//       "approve",
//       "reject"
//     ],
//     "path": [],
//     "message": "Invalid option: expected one of \"approve\"|\"reject\""
//   }
// ]
