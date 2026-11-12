// S2 middleware 体系（OUTLINE §3 S2）
// 四合一验收：① toolRetry 真触发（flaky 工具前两次抛错）② HITL 暂停→批准/拒绝两路（对照 write 确认门）
// ③ summarization 真触发（对照上下文压缩）④ 模型调用成本记账（wrapModelCall 观察 + afterModel 累计，对照 usage 账本）
// 跑法：仓库根 `node langChain/s2-middleware.ts`（dotenv 读根 .env；LangSmith trace 自动上报）
//
// 对照 personal-agent（跑完在复盘里落结论）：
// - HITL ↔ write 确认门：框架给的是「暂停点 + 四态决策(approve/edit/reject/respond)」，门是通的四通八达；
//   pa 是 fail-closed 二态（无门/超时/断流一律拒绝）——「框架给了暂停语义，放行策略仍是接入方的决策」
// - summarization ↔ 上下文压缩（先摘要旧轮再滑窗）：触发条件可组合（tokens/messages/fraction，单条 AND、数组 OR），
//   压缩用的模型可以单独指定（这里给 light 档——压缩是浅窗口活）
// - 成本记账 ↔ usage 账本 + COST_CEILING_TOKENS 护栏：记账这站做；「超顶 fail-closed」框架内置没有
//   （modelCallLimitMiddleware 只按调用次数机械闸），token 级成本护栏留 S3/S9 自己写
// - middleware 数组顺序 = 包装顺序（排前面的包排后面的）：HITL 必须排在 toolRetry 前面，否则重试会绕过人审
//   ——对照 pa：确认门在工具执行路径上不可绕过，是同一性质的位置约束
// - 钩子分工：wrap 系（wrapModelCall/wrapToolCall）管执行拦截（改请求/换响应/短路）；
//   before/after 系（beforeModel/afterModel/...）管状态补丁（返回即 patch）。写 state 用后者（或 Command，S1 已练）
import 'dotenv/config'
import {
  createAgent,
  tool,
  createMiddleware,
  toolRetryMiddleware,
  humanInTheLoopMiddleware,
  summarizationMiddleware,
} from 'langchain'
import { ChatOpenAI } from '@langchain/openai'
import { Command, MemorySaver, ReducedValue, StateSchema } from '@langchain/langgraph'
import * as z from 'zod'

const env = process.env
const main = new ChatOpenAI({
  model: env.LLM_MODEL!,
  apiKey: env.LLM_API_KEY!,
  configuration: { baseURL: env.LLM_BASE_URL! },
})
// 压缩/摘要这类浅窗口活给 light 档（对照 pa 大小模型路由：§7 判断/转写走小档）
const light = new ChatOpenAI({
  model: env.LLM_LIGHT_MODEL!,
  apiKey: env.LLM_LIGHT_API_KEY ?? env.LLM_API_KEY!,
  configuration: { baseURL: env.LLM_LIGHT_BASE_URL! },
})

// ── ④ 成本记账：wrapModelCall 逐次观察 usage（只读不改），afterModel 把增量累计进 state ──
// 对照 pa usage 账本：那里是主循环每轮记一行；这里拆成「观察（wrap）/记账（after）」两层，各归各的钩子
const Ledger = new StateSchema({
  usage: new ReducedValue(
    z
      .object({ calls: z.number(), tokensIn: z.number(), tokensOut: z.number() })
      .default(() => ({ calls: 0, tokensIn: 0, tokensOut: 0 })),
    {
      // ReducedValue：update 只传增量，加法进 reducer（S1 #66 的并发安全形态）
      reducer: (a, b) => ({ calls: a.calls + b.calls, tokensIn: a.tokensIn + b.tokensIn, tokensOut: a.tokensOut + b.tokensOut }),
    },
  ),
})
const costLedgerMiddleware = createMiddleware({
  name: 'cost-ledger',
  stateSchema: Ledger,
  wrapModelCall: async (request, handler) => {
    const response = await handler(request) // 不动请求不动响应，纯观察
    const u: any = response.usage_metadata
    console.log(`  [model] in=${u?.input_tokens} out=${u?.output_tokens}（请求里 messages=${request.messages.length} 条）`)
    return response
  },
  afterModel: (state: any) => {
    // afterModel 每次模型调用后都触发（带 tool_calls 的也算）——正好逐笔入账
    const u = state.messages.at(-1)?.usage_metadata
    if (u) return { usage: { calls: 1, tokensIn: u.input_tokens, tokensOut: u.output_tokens } } // 增量，reducer 合并
  },
})

// ── ① flaky 工具：前两次抛错第三次成功——toolRetry 的试炼场 ──
let flakyCalls = 0
const flakyLookup = tool(
  ({ topic }) => {
    flakyCalls++
    if (flakyCalls <= 2) throw new Error(`flaky 故障 #${flakyCalls}`)
    return `查到了（第 ${flakyCalls} 次尝试才成功）：${topic} 的资料`
  },
  {
    name: 'flaky_lookup',
    description: '查询主题资料。这个工具不稳定可能失败，失败会自动重试',
    schema: z.object({ topic: z.string().describe('主题名，如 LangChain') }),
  },
)

// ── ② 写入工具：HITL 的看门对象 ──
const notes: string[] = []
const writeNote = tool(
  ({ text }) => {
    notes.push(text)
    return `已记录（第 ${notes.length} 条）：${text}`
  },
  {
    name: 'write_note',
    description: '把结论记成笔记（写入操作，需要人工批准；被拒绝就把原因告诉用户，不要重试）',
    schema: z.object({ text: z.string().describe('要记录的结论，一句话') }),
  },
)

// interrupt 要求有 checkpointer（暂停期间整个 state 存这里）——S4 换 SQLite 玩进程重启续聊
const checkpointer = new MemorySaver()
const threadId = `s2-${Date.now()}`

const agent = createAgent({
  model: main,
  tools: [flakyLookup, writeNote],
  checkpointer,
  systemPrompt:
    '你是学习助手。查资料用 flaky_lookup；记录结论用 write_note（它是写入操作，需要人工批准，被拒绝时如实告诉用户，不要换个说法再试）。',
  middleware: [
    costLedgerMiddleware, // wrapModelCall 在最外层观察每一笔
    humanInTheLoopMiddleware({
      // 排在 toolRetry 前面：前面的包后面的，HITL 要裹住重试（顺序换掉 = 重试绕过人审）
      interruptOn: {
        write_note: {
          allowedDecisions: ['approve', 'reject'], // 四态里开两态（edit/respond 留给探针）
          description: '写入笔记需要人工批准',
        },
      },
    }),
    toolRetryMiddleware({ maxRetries: 3 }),
    summarizationMiddleware({
      model: light, // 压缩走 light 档
      trigger: { messages: 12 }, // 小阈值让它在本次脚本内真触发（单条件 AND、数组 OR 可组合）
      keep: { messages: 6 }, // 压缩后保留最近 6 条原文
    }),
  ],
})

// ═══ 场景① toolRetry 真触发 ═══
console.log('═══ 场景① flaky_lookup × toolRetry ═══')
let r: any = await agent.invoke(
  { messages: [{ role: 'user', content: '用 flaky_lookup 查一下 LangChain，一句话告诉我它是什么。' }] },
  { configurable: { thread_id: threadId } },
)
console.log('[①模型答复]', String(r.messages.at(-1)?.content))
console.log('[①flaky 实际执行次数]', flakyCalls, '（预期 3：两次抛错被 middleware 吃掉重试，模型只见最终成功）')

// ═══ 场景② HITL：暂停 → 批准 ═══
console.log('\n═══ 场景② write_note × HITL（approve 路径）═══')
r = await agent.invoke(
  { messages: [{ role: 'user', content: '把刚才查到的结论记成一条笔记。' }] },
  { configurable: { thread_id: threadId } },
)
if (r.__interrupt__) {
  console.log('[②审批卡]', JSON.stringify(r.__interrupt__[0]?.value, null, 2))
  r = await agent.invoke(new Command({ resume: { decisions: [{ type: 'approve' }] } }), {
    configurable: { thread_id: threadId },
  })
  console.log('[②批准后模型答复]', String(r.messages.at(-1)?.content))
  console.log('[②notes 落盘]', notes, '（预期 +1）')
} else {
  console.log('[②意外] 没有 __interrupt__——write_note 没被拦？检查 interruptOn 配置')
}

// ═══ 场景②b HITL：暂停 → 拒绝（fail 路径：工具不执行，模型收到拒绝理由）═══
console.log('\n═══ 场景②b write_note × HITL（reject 路径）═══')
r = await agent.invoke(
  { messages: [{ role: 'user', content: '再记一条笔记：LangGraph 是编排运行时。' }] },
  { configurable: { thread_id: threadId } },
)
if (r.__interrupt__) {
  r = await agent.invoke(
    new Command({ resume: { decisions: [{ type: 'reject', message: '这条已经记过了，不需要重复记录' }] } }),
    { configurable: { thread_id: threadId } },
  )
  console.log('[②b拒绝后模型答复]', String(r.messages.at(-1)?.content))
  console.log('[②bnotes 落盘]', notes, '（预期不变——reject = 工具不执行）')
}

// ═══ 场景③ summarization 真触发 ═══
console.log('\n═══ 场景③ summarization ═══')
const beforeCount = r.messages.length
console.log('[③压缩前消息数]', beforeCount, '（阈值 trigger: { messages: 12 }）')
r = await agent.invoke(
  { messages: [{ role: 'user', content: '把我们这轮聊的内容总结成一句话，然后用 flaky_lookup 查一下 DeepAgents。' }] },
  { configurable: { thread_id: threadId } },
)
console.log('[③压缩后消息数]', r.messages.length, '（预期：摘要消息 + 保留的 6 条 + 本轮新增）')
console.log('[③开头消息（预期变成摘要）]', JSON.stringify(r.messages[0]?.content)?.slice(0, 120), '...')

// ═══ 终局：成本账本（全 run 总账，state 里取）═══
console.log('\n═══ 成本账本（wrapModelCall 观察 / afterModel 累计）═══')
console.log('[usage 总账]', r.usage)
