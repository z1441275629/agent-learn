// S1 createAgent 工具循环（OUTLINE §3 S1）
// 三合一验收：① 流式打字 ② 工具调用（一读一写）③ 结构化输出
// 跑法：仓库根 `node langChain/s1-createAgent.ts`（dotenv 读根 .env；LangSmith trace 自动上报）
//
// 对照 personal-agent/core/agent.ts 的手写 runToolLoop，边跑边看——
// 框架替你做的：zod→工具 schema 生成、循环终止判定（模型不再要工具即收）、ToolMessage 回填进 messages
// 框架没做的：write_note 这种写入工具【默认直接执行，没有任何门】——
//   pa 的 write 确认门（fail-closed）在这套默认配置里不存在，S2 用 middleware 补
import 'dotenv/config'
import { createAgent, tool } from 'langchain'
import { ChatOpenAI } from '@langchain/openai'
import * as z from 'zod'

const env = process.env
const llm = new ChatOpenAI({
  model: env.LLM_MODEL!,
  apiKey: env.LLM_API_KEY!,
  configuration: { baseURL: env.LLM_BASE_URL! }, // 方舟 OpenAI 兼容端点
})

// 工具一：只读（查一个内存小库）
const db: Record<string, string> = {
  LangChain: 'v1 以 createAgent + middleware 为中心，旧 AgentExecutor/LLMChain/Legacy Memory 全废弃',
  LangGraph: 'StateGraph 编排运行时：持久化/interrupt/流式，LangChain 的 agent 建在它上面',
  DeepAgents: '带电池的 harness：虚拟文件系统、子代理、skills、memory',
}
const lookup = tool(({ topic }) => db[topic] ?? `库里没有「${topic}」`, {
  name: 'lookup',
  description: '查询内置知识库，返回该主题的一句话资料',
  schema: z.object({ topic: z.string().describe('主题名，如 LangChain') }),
})

// 工具二：写入（对照点——这一步会真的执行，没人拦）
const notes: string[] = []
const writeNote = tool(({ text }) => {
  notes.push(text)
  return `已记录（第 ${notes.length} 条）：${text}`
}, {
  name: 'write_note',
  description: '把一条学习结论写进笔记',
  schema: z.object({ text: z.string().describe('要记录的结论，一句话') }),
})

const agent = createAgent({
  model: llm,
  tools: [lookup, writeNote],
  systemPrompt: '你是学习助手：先用 lookup 查资料再下结论，最后用 write_note 记一条核心结论。',
  responseFormat: z.object({
    conclusion: z.string(),
    source: z.enum(['lookup', '模型自身']),
  }),
  name: 's1-agent',
})

// 流式消费：v1.3+ 的 streamEvents 类型化投影——token 流与工具事件各自独立迭代，最后 await 拿终态
const stream = await agent.streamEvents(
  { messages: [{ role: 'user', content: 'LangChain 的 v1 核心抽象是什么？查完记一条笔记。' }] },
  { version: 'v3' },
)
await Promise.all([
  (async () => {
    for await (const message of stream.messages) {
      for await (const token of message.text) process.stdout.write(token)
    }
    process.stdout.write('\n')
  })(),
  (async () => {
    for await (const call of stream.toolCalls) {
      const out = await call.output
      console.log(`\n[tool] ${call.name}(${JSON.stringify(call.input)}) → ${String(out?.content ?? out)}`)
    }
  })(),
])
const finalState: any = await stream.output
console.log('\n[structured]', finalState.structuredResponse)
console.log('[notes 实际落盘]', notes)
