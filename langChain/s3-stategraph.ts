// S3 LangGraph 状态机（OUTLINE §3 S3，本线重头之一）
// 三合一验收：① 路由三态条件边（normal/plan/composite，对照 chat-service 路由）
// ② Send map-reduce 并行（planner 拆步 → fan-out 并行执行 → append reducer 聚合——手写没造过的重点）
// ③ composite 子图挂载（研究→审校→修订回边 + ≤2 次熔断，对照 composite 编排/修订熔断）
// 跑法：仓库根 `node langChain/s3-stategraph.ts`（LangSmith trace 可看子图嵌套树）
//
// 对照 personal-agent（跑完复盘落结论）：
// - 路由三态 ↔ chat-service 路由：pa 是代码路由 + 判定窗口模型；这里路由本身是 LLM 判定 + 条件边分发——
//   同一语义的两种实现，「路由」在图里就是一条 addConditionalEdges
// - Send fan-out ↔ planner 模块 dispatch（已打过桩）+ 手写 PARALLEL 的 Promise.all——
//   并行从节点内部升进图拓扑，框架管批调度，节点只管声明「这一步的输入」
// - results 的 ReducedValue(inputSchema: string, append reducer) ↔ 账本 append 语义；
//   Send 并行写的聚合点必须是 reducer channel——换成裸 z.array() 当场 InvalidUpdateError（P5/#66 复现位，探针①）
// - composite 子图 ↔ composite 编排：research→review→(FAIL 且未熔断)→revise→review 回边 = 修订循环；
//   revisions >= 2 直接放行 = 修订熔断 ≤2 轮。子图与父图的交接面 = 两边 schema 的同名 keys（显式契约非隐式全局）
// - StateSchema（本文件）vs Annotation.Root（planner 模块）：同一张图两种 state 定义形态，都见一遍
import 'dotenv/config'
import { ChatOpenAI } from '@langchain/openai'
import { StateGraph, StateSchema, ReducedValue, MessagesValue, Send, START, END } from '@langchain/langgraph'
import { HumanMessage, AIMessage } from 'langchain'
import * as z from 'zod'

const env = process.env
const llm = new ChatOpenAI({
  model: env.LLM_MODEL!,
  apiKey: env.LLM_API_KEY!,
  configuration: { baseURL: env.LLM_BASE_URL! },
})
const ask = async (system: string, user: string) =>
  String((await llm.invoke([{ role: 'system', content: system }, { role: 'user', content: user }])).content)
// 花括号切片剥 JSON 围栏（planner probe 验证过比剥 fence 鲁棒）
const extractJson = (raw: string) => {
  const start = raw.indexOf('{'),
    end = raw.lastIndexOf('}')
  return start >= 0 && end > start ? raw.slice(start, end + 1) : raw.trim()
}
const lastUser = (s: any) => {
  const arr: any[] = s.messages ?? []
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i].getType?.() === 'human') return String(arr[i].content)
  return ''
}

// ── 主图 state（StateSchema 形态）──
const Route = z.enum(['normal', 'plan', 'composite'])
const MainState = new StateSchema({
  messages: MessagesValue, // 预置的 BaseMessage[] append 通道
  route: Route.default('normal'), // 覆盖语义（无 reducer = LastValue）——静态判定整张换
  steps: z.array(z.object({ id: z.number(), desc: z.string() })).default(() => []), // planner 产物，覆盖语义
  results: new ReducedValue(
    z.array(z.string()).default(() => []),
    {
      inputSchema: z.string(), // 存数组、写单条：节点 update 传一个 string，reducer 负责 append（账本同构）
      reducer: (cur, next) => [...cur, next],
    },
  ),
  // ↓ 子图交接面：三个字段两边 schema 同名声明，这就是父子的全部契约
  draft: z.string().default(''),
  verdict: z.enum(['PASS', 'FAIL']).default('FAIL'),
  revisions: z.number().default(0),
  note: z.string().default(''), // 审校意见，revise 的输入
})

// ── composite 子图：研究→审校→(FAIL 且未熔断)→修订→再审；PASS 或熔断(≥2) 出图 ──
const CompositeState = new StateSchema({
  messages: MessagesValue,
  draft: z.string().default(''),
  verdict: z.enum(['PASS', 'FAIL']).default('FAIL'),
  revisions: z.number().default(0),
  note: z.string().default(''),
})
const composite = new StateGraph(CompositeState)
  .addNode('research', async (s: any) => {
    console.log('    [子图/research] 写初稿')
    return { draft: await ask('研究员。就用户主题写一段 100 字内的简报初稿，只陈述事实不要修饰。', lastUser(s)) }
  })
  .addNode('review', async (s: any) => {
    const raw = await ask(
      '审校。判断初稿是否「准确、无编造、无空话」。只回 JSON：{"verdict":"PASS"} 或 {"verdict":"FAIL","reason":"一句话意见"}',
      `主题：${lastUser(s)}\n初稿：${s.draft}`,
    )
    let j: any = {}
    try {
      j = JSON.parse(extractJson(raw))
    } catch {
      j = { verdict: 'FAIL', reason: '审校输出解析失败' }
    }
    console.log(`    [子图/review] ${j.verdict}${j.reason ? '：' + j.reason : ''}（已修订 ${s.revisions} 次）`)
    return { verdict: j.verdict === 'PASS' ? 'PASS' : 'FAIL', note: String(j.reason ?? '') }
  })
  .addNode('revise', async (s: any) => {
    console.log('    [子图/revise] 按意见修订')
    return {
      draft: await ask('写手。按审校意见修订初稿，100 字内。', `初稿：${s.draft}\n审校意见：${s.note}`),
      revisions: s.revisions + 1, // 修订计数（熔断依据）
    }
  })
  .addEdge(START, 'research')
  .addEdge('research', 'review')
  .addConditionalEdges(
    'review',
    (s: any) => (s.verdict === 'PASS' || s.revisions >= 2 ? 'done' : 'revise'), // 回边=修订循环；≥2=熔断放行
    { done: END, revise: 'revise' },
  )
  .addEdge('revise', 'review')
  .compile()

// ── 主图：路由三态条件边 + Send map-reduce + 子图挂载 ──
const graph = new StateGraph(MainState)
  .addNode('router', async (s: any) => {
    const raw = await ask(
      '路由器。判定任务类型，只回 JSON：{"route":"normal"}=单点问答/闲聊；{"route":"plan"}=多件事分别处理再汇总/对比；{"route":"composite"}=要求成稿输出（写短文/报告）',
      lastUser(s),
    )
    let route: string = 'normal'
    try {
      const j = JSON.parse(extractJson(raw))
      if (['normal', 'plan', 'composite'].includes(j.route)) route = j.route
    } catch {} // 解析失败回落 normal（练习文件的宽处理；pa 对照：这里是 fail-open，产线应 fail-closed）
    console.log(`  [router] → ${route}`)
    return { route }
  })
  .addNode('answer', async (s: any) => ({ messages: [new AIMessage(await ask('助手，直接回答，一句话。', lastUser(s)))] }))
  .addNode('planner', async (s: any) => {
    const raw = await ask(
      '规划器。把任务拆成 2~3 个可独立并行的子任务，只回 JSON：{"steps":[{"id":1,"desc":"..."}]}',
      lastUser(s),
    )
    let steps: any[] = []
    try {
      steps = JSON.parse(extractJson(raw)).steps ?? []
    } catch {}
    console.log(`  [planner] 拆 ${steps.length} 步，Send fan-out`)
    return { steps }
  })
  // Send 私货：exec 不读共享 state，每次调用拿自己的快照输入（节点间无共享内存，交接必须显式——planner 模块同款）
  .addNode('exec', async (i: any) => {
    console.log(`    [exec] 步骤${i.step.id} 开跑（与同批并行）`)
    const out = await ask('执行器。完成这一步，50 字内给出成果。', `总任务：${i.question}\n本步：${i.step.desc}`)
    return { results: `【${i.step.id}】${out}` } // 单条进 reducer，append 语义
  })
  .addNode('merge', async (s: any) => {
    const out = await ask('汇总器。把各步成果合成一段连贯回答，150 字内。', s.results.join('\n'))
    return { messages: [new AIMessage(out)] }
  })
  .addNode('composite', composite) // 编译好的子图直接当节点——交接面=同名 keys
  .addNode('report', async (s: any) => ({
    messages: [new AIMessage(`[composite 成稿 | ${s.verdict} 出图 | 修订 ${s.revisions} 次]\n${s.draft}`)],
  }))
  .addEdge(START, 'router')
  .addConditionalEdges('router', (s: any) => s.route, { normal: 'answer', plan: 'planner', composite: 'composite' })
  .addEdge('answer', END)
  .addConditionalEdges(
    'planner',
    (s: any) => s.steps.map((step: any) => new Send('exec', { step, question: lastUser(s) })), // 数组=一批 Send（map-reduce 的 map）
    { exec: 'exec' },
  )
  .addEdge('exec', 'merge') // 同一 superstep 的全部 exec 完成后，merge 在下一跳跑一次（reduce）
  .addEdge('merge', END)
  .addEdge('composite', 'report')
  .addEdge('report', END)
  .compile()

// ── 三场景跑一遍（normal / plan / composite 各一路）──
const scenes: Array<[string, string]> = [
  ['normal', 'LangGraph 的 StateGraph 是什么？一句话。'],
  ['plan', '分别查 LangChain、LangGraph、DeepAgents 各自的定位，最后给我一个对比总结。'],
  ['composite', '写一段 100 字左右的短文：介绍 LangChain v1 的 middleware 体系。'],
]
for (const [name, q] of scenes) {
  console.log(`\n═══ 场景 ${name}：${q} ═══`)
  const t0 = Date.now()
  const r: any = await graph.invoke({ messages: [new HumanMessage(q)] }, { recursionLimit: 50 })
  console.log(`[答·${((Date.now() - t0) / 1000).toFixed(1)}s]`, String(r.messages.at(-1)?.content).slice(0, 200))
  if (name === 'plan') console.log('[results 聚合账本]', r.results)
}
