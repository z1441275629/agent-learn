// S6 多 agent 三模式（OUTLINE §3 S6 重头之二 · part1）：subagents / handoffs / supervisor
// 同一个客服场景（tech 技术支持 + billing 账单专员）三种编排，对照点=「对话控制权在谁手里」。
// 跑法：
//   node langChain/s6-multiagent.ts subagents          # 派活拿报告：主 agent 握权，子代理=临时工
//   node langChain/s6-multiagent.ts handoff            # 交棒：控制权随对话转移，专家直接面对用户
//   node langChain/s6-multiagent.ts supervisor         # 外呼电话：主管握权，专员只是工具调用
//   可选第二参数自定义问题（默认混合问题，逼出多专家协作）：
//   node langChain/s6-multiagent.ts supervisor "发票抬头怎么改"
//
// 三模式控制权对照（面试核心）：
// - subagents（deepagents 的 task 工具）：主 agent 全程握权——子代理 isolated 上下文只见子任务，
//   干完交报告即走。加帮手不动主图。JS 注意：subagents 中间件不在 langchain 本体，在 deepagents 包
// - handoff（图节点 + transfer 工具返回 Command goto）：控制权真的转移——对话漂到专家手里，
//   专家直接对用户说话，想回前台得再交棒。骨架与 pa composite 的研究员/审校同构（图节点确定性流转），
//   区别是这里的跳转由「模型决定调 transfer 工具」触发，composite 由条件边触发
// - supervisor（agents-as-tools）：主管握权——专员被包成工具 invoke，用户永远只见主管。
//   对照 pa：无对应物（单 agent），但 ask_tech 的包装形态 = wrapModelCall 同族思路（把子调用藏进工具）
//
// 判定节点纪律（PITFALLS #67）：handoff 的 triage 是路由判定 → 温度 0 + 思考关
import 'dotenv/config'
import { createAgent, tool, HumanMessage, ToolMessage } from 'langchain'
import { ChatOpenAI } from '@langchain/openai'
import { StateGraph, StateSchema, MessagesValue, Command, START, END } from '@langchain/langgraph'
import { createSubAgentMiddleware } from 'deepagents'
import * as z from 'zod'

const env = process.env
// 产出节点默认参数；router 单独实例锁判定参数
const llm = new ChatOpenAI({
  model: env.LLM_MODEL!,
  apiKey: env.LLM_API_KEY!,
  configuration: { baseURL: env.LLM_BASE_URL! },
})
const routerLlm = new ChatOpenAI({
  model: env.LLM_MODEL!,
  apiKey: env.LLM_API_KEY!,
  configuration: { baseURL: env.LLM_BASE_URL! },
  temperature: 0,
  modelKwargs: { thinking: { type: 'disabled' } }, // S3 纪律：路由=直觉判断，锁死
})

const question = process.argv[3] ?? '键盘进水了怎么急救？顺便问下上个月的发票抬头能改吗？'
const ask = async (agent: any, text: string) => {
  const r = await agent.invoke({ messages: [new HumanMessage(text)] }, { configurable: { thread_id: 's6' } })
  console.log(`  答：${String(r.messages.at(-1)?.content)}`)
}

const mode = process.argv[2] ?? 'subagents'

// ═══ 模式① subagents：task 工具派活拿报告（控制权在主 agent）═══
if (mode === 'subagents') {
  console.log('═══ S6 subagents：主 agent 握权，子代理=隔离上下文的临时工 ═══')
  console.log(`问：${question}`)
  const host = createAgent({
    model: llm,
    systemPrompt:
      '你是客服前台。技术故障用 task 工具派给 tech-support 子代理，账单/发票问题派给 billing 子代理；拿到报告后你自己总结作答，别转述子代理原话。',
    middleware: [
      createSubAgentMiddleware({
        defaultModel: llm,
        subagents: [
          {
            name: 'tech-support',
            description: '硬件/软件技术故障的诊断建议',
            systemPrompt: '你是技术支持专员。只处理技术问题，给出一两句可执行结论。',
          },
          {
            name: 'billing',
            description: '账单、退款、发票问题',
            systemPrompt: '你是账单专员。只处理账单问题，给出一两句结论。',
          },
        ],
      }),
    ],
  })
  await ask(host, question)
  console.log(
    '[要点] 子代理 isolated：只见子任务不见全程对话；主 agent 收报告继续答——LangSmith 里能看到 task 前后两条独立轨迹',
  )
}

// ═══ 模式② handoff：transfer 工具交棒（控制权真的转移）═══
else if (mode === 'handoff') {
  console.log('═══ S6 handoff：Command goto 交棒，对话漂到专家手里 ═══')
  console.log(`问：${question}`)
  // 交棒工具：Command goto + update 补写 ToolMessage——两件缺一不可：
  // 只带 goto（第一版踩坑）：ToolMessage 不落 state → 线程挂着悬空 tool_call，
  // 接手 agent 收到一条不是自己发的调用（工具还不在它手上），模型直接回空消息收场
  // （#66「Command 不带 messages = 工具结果丢失」在 handoff 场景的放大版：丢的不只是结果，
  //  是下一个 agent 的行为完整性——官方 handoff 模式的完整形态就是 goto + update 一起给）
  // 第二参数 runtime: ToolRuntime 自动注入，toolCallId 用来造 ToolMessage
  const toBilling = tool(
    (_args: any, runtime: any) => {
      console.log('  [交棒] tech → billing')
      return new Command({
        goto: 'billing',
        update: { messages: [new ToolMessage({ tool_call_id: runtime.toolCallId, content: '对话已交棒：你现在是账单专员，直接面对用户。先找出对话里尚未被处理的问题，再以账单专员身份作答，别重复已答内容。' })] },
      })
    },
    { name: 'transfer_to_billing', description: '把对话交给账单专员（账单/退款/发票问题）', schema: z.object({}) },
  )
  const toTech = tool(
    (_args: any, runtime: any) => {
      console.log('  [交棒] billing → tech')
      return new Command({
        goto: 'tech',
        update: { messages: [new ToolMessage({ tool_call_id: runtime.toolCallId, content: '对话已交棒：你现在是技术支持专员，直接面对用户。先找出对话里尚未被处理的问题，再以技术支持专员身份作答，别重复已答内容。' })] },
      })
    },
    { name: 'transfer_to_tech', description: '把对话交给技术支持专员（硬件/软件故障）', schema: z.object({}) },
  )

  const tech = createAgent({
    model: llm,
    systemPrompt:
      '你是技术支持专员，直接面对用户。只答技术问题；遇到账单/发票问题必须调 transfer_to_billing 交棒。每轮一两句话。',
    tools: [toBilling],
  })
  const billing = createAgent({
    model: llm,
    systemPrompt: '你是账单专员，直接面对用户。只答账单问题；遇到技术问题必须调 transfer_to_tech 交棒。每轮一两句话。',
    tools: [toTech],
  })

  // triage 判定节点：锁参数（#67），与 S3 路由同构
  const HandoffState = new StateSchema({ messages: MessagesValue })
  const graph = new StateGraph(HandoffState)
    .addNode(
      'triage',
      async (s: any) => {
        const r = await routerLlm.invoke([
          new HumanMessage(`只输出一个词：tech 或 billing。问题：${String(s.messages.at(-1)?.content)}`),
        ])
        const pick = String(r.content).toLowerCase().includes('billing') ? 'billing' : 'tech'
        console.log(`  [triage] 判定 → ${pick}`)
        return new Command({ goto: pick }) // 节点级 goto（S1/S2 的 jumpTo 亲戚，StateGraph 原生形态）
      },
      { ends: ['tech', 'billing'] },
    )
    // UnreachableNodeError: Node `tech` is not reachable.
    // If you are returning Command objects from your node,
    // make sure you are passing names of potential destination nodes as an "ends" array
    // into ".addNode(..., { ends: ["node1", "node2"] })".

    // 坑：createAgent 返回 ReactAgent——不是 Runnable，直接 addNode 抛
    // "Expected a Runnable, function or object"。编译好的图在 .graph 属性（get graph(): AgentGraph）
    .addNode('tech', tech.graph)
    .addNode('billing', billing.graph)
    .addEdge(START, 'triage')
    .addEdge('tech', END)
    .addEdge('billing', END)
    .compile()
  const r = await graph.invoke({ messages: [new HumanMessage(question)] })
  // 转储全消息清单：交棒 = return Command goto（无 update）→ ToolMessage 不落 state（#66 同款），
  // 线程里会挂悬空 tool_call——空答案的现场全在这里
  console.log(`  ── 最终 ${r.messages.length} 条消息 ──`)
  for (const msg of r.messages) {
    const m = msg as any
    const tc = m.tool_calls?.length ? ` tool_calls=[${m.tool_calls.map((t: any) => t.name).join(',')}]` : ''
    console.log(`   · ${m.getType?.() ?? '?'}${tc}: ${JSON.stringify(m.content).slice(0, 80)}`)
  }
  console.log(
    '[要点] 交棒后对话在专家手里，用户直接被专家答复——对照 composite：那里跳转由条件边（代码）决定，这里由模型调工具（判断）触发',
  )
}

// ═══ 模式③ supervisor：agents-as-tools（主管握权，专员=外呼电话）═══
else if (mode === 'supervisor') {
  console.log('═══ S6 supervisor：专员包成工具，用户只面对主管 ═══')
  console.log(`问：${question}`)
  const techWorker = createAgent({ model: llm, systemPrompt: '你是技术支持专员。给出一两句可执行结论，不寒暄。' })
  const billingWorker = createAgent({ model: llm, systemPrompt: '你是账单专员。给出一两句结论，不寒暄。' })
  // JS 版没有 .asTool()（Python 有）——手动包：编译后的 agent 就是个可 invoke 的 graph
  const askTech = tool(
    async ({ q }) => {
      console.log('  [外呼] tech 专员')
      return String((await techWorker.invoke({ messages: [new HumanMessage(q)] })).messages.at(-1).content)
    },
    {
      name: 'ask_tech',
      description: '让技术支持专员回答一个技术问题',
      schema: z.object({ q: z.string().describe('给专员的问题') }),
    },
  )
  const askBilling = tool(
    async ({ q }) => {
      console.log('  [外呼] billing 专员')
      return String((await billingWorker.invoke({ messages: [new HumanMessage(q)] })).messages.at(-1).content)
    },
    {
      name: 'ask_billing',
      description: '让账单专员回答一个账单问题',
      schema: z.object({ q: z.string().describe('给专员的问题') }),
    },
  )
  const supervisor = createAgent({
    model: llm,
    systemPrompt: '你是客服主管。把问题按主题分给 ask_tech / ask_billing（可以都问），拿到答复后汇总成一段回答。',
    tools: [askTech, askBilling],
  })
  await ask(supervisor, question)
  console.log(
    '[要点] 专员无记忆无上下文延续（每次 invoke 独立线程）——与 subagents 的差别：这里是主管主动外呼，那边是主 agent 派活；都拿报告，但 supervisor 的专员暴露成了工具签名',
  )
} else console.log(`未知模式：${mode}（subagents | handoff | supervisor）`)
