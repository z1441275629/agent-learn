// S8 流式站 part1（OUTLINE §3 S8）：streamMode 三种粒度 + custom 自定义事件通道
// 跑法：
//   node langChain/s8-stream.ts            # 全跑：图A 三段（零 token）+ 图B token 流（一次 LLM 小调用）
// 验收（站级）：前端实时收到 token 流 + 工具事件 → 见 s8-server.ts + s8-frontend.html（part2）
//
// 设计（省 token 纪律）：
// - 图A 零 token 纯函数图：values / updates / custom 三个通道的「粒度语义」用纯函数节点看最清楚
//   （values=每步后全量 state 越滚越大；updates=只有节点名+增量；custom=节点内 dispatch 的旁路事件）
// - 图B 才花 token（llm.bindTools 小 agent 图）：messages 通道的 token 级流（AIMessageChunk），
//   只有它必须真 LLM——验收件「前端实时收到 token 流」靠它
//
// 对照 pa（OUTLINE 原文的对照点）：
// - pa chat.ts 是【单通道 SSE + type 字段分流】：delta/tool/done 帧混在一条流里，
//   「工具帧与文本帧交错」的边界自己管（onText/onToolCall 两个回调各自 send）
// - 框架给【多通道】：streamMode 数组一次订阅多条，产出 [mode, payload] 元组交错到达，
//   交错边界由通道标识解决——不用自己在帧里塞 type 判别
// - pa 每帧自带语义（type 字段）vs 框架每个通道语义单一——合成给前端的帧是翻译层的活（s8-server）
//
// custom 通道（实测 #76，langgraph 1.5.3 零 token 探针三姿势实证）：
// - dispatchCustomEvent（@langchain/core）是【core 回调系统】的自定义事件——进 streamEvents 的
//   on_custom_event，与 LangGraph 的 custom 流通道无关，名字像系统不同
// - 1.5.3 的 writer() 导出函数只读 config.configurable.writer——Pregel 实际挂的是顶层 config.writer
//   → 可选链静默空转（零报错零事件）；getWriter() 或节点第二参 config.writer 才活
// - 载荷形状：chunk 原样出现在 custom 通道（探针实证）

import 'dotenv/config'
import { StateGraph, MessagesAnnotation, START, END, Annotation, getWriter } from '@langchain/langgraph'
import { AIMessage, AIMessageChunk } from '@langchain/core/messages'
import { ChatOpenAI } from '@langchain/openai'
import { tool, ToolMessage } from 'langchain'
import * as z from 'zod'

// ═══ 图A：零 token 纯函数图——values / updates / custom 的粒度语义 ═══
// state：stage（LastValue 覆盖）+ steps（append 账本——增量在 updates 里看得到差集）
const AState = Annotation.Root({
  stage: Annotation<string>({ reducer: (_a, b) => b, default: () => 'init' }),
  steps: Annotation<string[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }),
})
const graphA = new StateGraph(AState)
  .addNode('prepare', async () => {
    getWriter()?.({ event: 'progress', at: 'prepare', note: '旁路事件：准备阶段开始' }) // custom 通道写入姿势见头注 #76
    return { stage: '准备完', steps: ['prepare'] }
  })
  .addNode('enrich', async () => {
    getWriter()?.({ event: 'progress', at: 'enrich', note: '旁路事件：加工阶段开始' })
    return { stage: '加工完', steps: ['enrich'] }
  })
  .addEdge(START, 'prepare')
  .addEdge('prepare', 'enrich')
  .addEdge('enrich', END)
  .compile()

console.log('═══ ① streamMode: "values" —— 每步后【全量 state】（越滚越大）═══')
for await (const v of await graphA.stream({ stage: 'init', steps: [] }, { streamMode: 'values' })) {
  console.log(`  values → ${JSON.stringify(v)}`)
}

console.log('\n═══ ② streamMode: "updates" —— 只有【节点名 + 增量】（差集语义）═══')
for await (const u of await graphA.stream({ stage: 'init', steps: [] }, { streamMode: 'updates' })) {
  console.log(`  updates → ${JSON.stringify(u)}`)
}

console.log('\n═══ ③ streamMode: ["values","updates","custom"] —— 多通道订阅：[mode, payload] 元组交错 ═══')
for await (const [mode, payload] of await graphA.stream(
  { stage: 'init', steps: [] },
  { streamMode: ['values', 'updates', 'custom'] },
)) {
  const s = JSON.stringify(payload)
  console.log(`  [${mode}] ${s.length > 90 ? s.slice(0, 90) + '…' : s}`)
}
console.log('  ↑ 对照 pa：这些 [mode,payload] 要是单通道就得在帧里塞 type 字段自己分流')

// ═══ 图B：llm.bindTools 小 agent 图——messages 通道的 token 级流 ═══
// 为什么手写不用 createAgent：messages 的 metadata.langgraph_node 能标「哪个节点在说话」——
// 手写图节点名可控（respond/use_tools），正好接 S6 的伏笔：handoff 无收口人 → 生产走流式全量回放，
// 回放的实现基础就是「每片 chunk 带 langgraph_node，前端按节点归档显示」
const env = process.env
const llm = new ChatOpenAI({ model: env.LLM_MODEL!, apiKey: env.LLM_API_KEY!, configuration: { baseURL: env.LLM_BASE_URL! } })

// 本地确定性工具（零外部依赖）：查「站牌」假数据
const stationInfo = tool(
  (args: { station: string }) => {
    const table: Record<string, string> = {
      S8: 'S8 流式+前端站。验收：前端实时收到 token 流 + 工具事件。内容：streamMode values/updates/messages 三粒度 + custom 通道。',
    }
    return table[args.station] ?? `没有 ${args.station} 的站牌记录（已知站：S8）`
  },
  { name: 'station_info', description: '查学习大纲某站的站牌信息（验收标准与内容）', schema: z.object({ station: z.string().describe('站号，如 S8') }) },
)

const shouldUseTools = (s: typeof MessagesAnnotation.State) => {
  const last = s.messages.at(-1)
  return last instanceof AIMessage && (last.tool_calls?.length ?? 0) > 0 ? 'use_tools' : END
}

const graphB = new StateGraph(MessagesAnnotation)
  .addNode('respond', async (s: typeof MessagesAnnotation.State) => ({ messages: [await llm.bindTools([stationInfo]).invoke(s.messages)] }))
  .addNode('use_tools', async (s: typeof MessagesAnnotation.State) => ({
    // 坑（实测 #75）：langchain 工具是 Runnable，invoke 契约是异步——底层函数哪怕是同步的也返回
    // Promise。String(promise) 不抛错，静默产出 "[object Promise]" 喂给模型（模型重试三次后道歉
    // 说工具坏了——它没说错）。手动执行框架工具 = 异步 RPC，必须 await；并发多工具调用包 Promise.all
    messages: await Promise.all(
      ((s.messages.at(-1) as AIMessage).tool_calls ?? []).map(
        async (tc) => new ToolMessage({ tool_call_id: tc.id!, name: tc.name, content: String(await stationInfo.invoke(tc.args as { station: string })) }),
      ),
    ),
  }))
  .addEdge(START, 'respond')
  .addConditionalEdges('respond', shouldUseTools, ['use_tools', END])
  .addEdge('use_tools', 'respond')
  .compile()

console.log('\n═══ ④ streamMode: "messages" —— token 级 AIMessageChunk 流（花 token 的一段）═══')
const Q = '用 station_info 查一下 S8 站的验收标准，然后用一句话告诉我。'
console.log(`问：${Q}`)
let text = ''
let sawNode = new Set<string>()
for await (const [chunk, meta] of await graphB.stream({ messages: [{ role: 'user', content: Q }] }, { streamMode: 'messages' })) {
  if (chunk instanceof AIMessageChunk) {
    const node = String((meta as any)?.langgraph_node ?? '?')
    sawNode.add(node)
    if (chunk.content) {
      text += chunk.content
      process.stdout.write(chunk.content) // token 片段直接透传——pa onText(delta) 同款语义
    }
    if (chunk.tool_call_chunks?.length) console.log(`\n  [tool_call chunk] ${JSON.stringify(chunk.tool_call_chunks[0]).slice(0, 100)}`)
  }
  // 工具结果消息也走 messages 通道（完整 ToolMessage 非 chunk）——前端要区分，见 s8-server 翻译层
}
console.log(`\n  ✓ 累计 ${text.length} 字；发言节点：${[...sawNode].join(' / ')}（langgraph_node 标签——多 agent 回放的归档基础）`)
