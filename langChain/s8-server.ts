// S8 流式站 part2（验收件）：SSE 桥——把框架多通道流翻译成 pa 风格帧，喂给 50 行前端
// 跑法：
//   node langChain/s8-server.ts            # 起服务（默认 :8788，S8_PORT 可覆盖）→ 浏览器开 http://localhost:8788
//   验证完 Ctrl+C 停服务
// 验收：浏览器里实时看到 token 流（delta）+ 工具事件（tool）+ custom 事件
//
// 这一层就是 OUTLINE 对照点的活代码：
// - pa chat.ts（单通道）：onText/onToolCall 回调各自 send({type:...})——帧协议自己设计，
//   「工具帧与文本帧交错」的边界在循环层自己管
// - 框架（多通道）：streamMode ['messages','updates','custom'] 一次订阅，[mode,payload] 元组交错到达，
//   每通道语义单一；交错边界由通道标识解决
// - 本文件 = 翻译层：messages 通道的 AIMessageChunk → delta 帧；ToolMessage → tool 帧；
//   custom 通道 → custom 帧；流尽 → done 帧。前端拿到的还是 pa 形状的协议——两层协议的桥
//
// 细节坑预告（跑了核对）：
// - messages 通道不只有 AIMessageChunk：工具结果 ToolMessage（完整非 chunk）也走它，
//   翻译层必须 instanceof 区分——把 ToolMessage 当 delta 透传就是乱码帧
// - AIMessageChunk.content 可能是数组（多段 content block）——只透传 string 形态的增量
// - stateless demo：无 checkpointer，thread_id 每请求随机——本站验收不需要会话连续性（那是 S4 的活）

import 'dotenv/config'
import * as http from 'node:http'
import * as fs from 'node:fs'
import { StateGraph, MessagesAnnotation, START, END, getWriter } from '@langchain/langgraph'
import { AIMessage, AIMessageChunk } from '@langchain/core/messages'
import { ChatOpenAI } from '@langchain/openai'
import { tool, ToolMessage } from 'langchain'
import * as z from 'zod'

const env = process.env
const PORT = Number(env.S8_PORT || 8788)
const llm = new ChatOpenAI({ model: env.LLM_MODEL!, apiKey: env.LLM_API_KEY!, configuration: { baseURL: env.LLM_BASE_URL! } })

// 图：与 s8-stream.ts 图B 同构（自包含复制——仓库模式：一个文件一个可跑单元），加 custom 事件演示
const stationInfo = tool(
  (args: { station: string }) => {
    const table: Record<string, string> = {
      S8: 'S8 流式+前端站。验收：前端实时收到 token 流 + 工具事件。',
      S9: 'S9 毕业项目站。作品集，正规点的那种。',
    }
    return table[args.station] ?? `没有 ${args.station} 的站牌记录（已知站：S8/S9）`
  },
  { name: 'station_info', description: '查学习大纲某站的站牌信息', schema: z.object({ station: z.string().describe('站号，如 S8') }) },
)

const shouldUseTools = (s: typeof MessagesAnnotation.State) => {
  const last = s.messages.at(-1)
  return last instanceof AIMessage && (last.tool_calls?.length ?? 0) > 0 ? 'use_tools' : END
}

const graph = new StateGraph(MessagesAnnotation)
  .addNode('respond', async (s: typeof MessagesAnnotation.State) => ({ messages: [await llm.bindTools([stationInfo]).invoke(s.messages)] }))
  .addNode('use_tools', async (s: typeof MessagesAnnotation.State) => {
    // 坑（#75）：工具 invoke 是异步契约（Runnable），String(promise) 静默变 "[object Promise]"
    const results = await Promise.all(
      ((s.messages.at(-1) as AIMessage).tool_calls ?? []).map(
        async (tc) => new ToolMessage({ tool_call_id: tc.id!, name: tc.name, content: String(await stationInfo.invoke(tc.args as { station: string })) }),
      ),
    )
    // custom 通道写入（#76）：dispatchCustomEvent 是 core 回调系统（streamEvents 的 on_custom_event）
    // 不进 custom 流通道；1.5.3 的 writer() 导出只读 configurable.writer 静默空转——getWriter() 才活
    getWriter()?.({ event: 'tool-done', tools: results.map((r) => r.name) }) // 旁路事件不进 state
    return { messages: results }
  })
  .addEdge(START, 'respond')
  .addConditionalEdges('respond', shouldUseTools, ['use_tools', END])
  .addEdge('use_tools', 'respond')
  .compile()

const server = http.createServer(async (req, res) => {
  // 静态：根路径直接回前端单文件（零构建，50 行精神）
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(fs.readFileSync(new URL('./s8-frontend.html', import.meta.url)))
    return
  }
  if (req.method !== 'POST' || req.url !== '/api/chat') {
    res.writeHead(404).end()
    return
  }

  // 读 body
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  const { q } = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{"q":""}')
  console.log(`[s8] 问：${q}`)

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const send = (frame: Record<string, unknown>) => res.write(`data: ${JSON.stringify(frame)}\n\n`) // pa 同款 SSE 帧格式
  const t0 = Date.now()
  try {
    const stream = await graph.stream({ messages: [{ role: 'user', content: String(q) }] }, {
      streamMode: ['messages', 'custom'],
      configurable: { thread_id: `s8-${Date.now()}` }, // stateless：每请求新线程（无 checkpointer，头注已注）
    })
    for await (const [mode, payload] of stream) {
      if (mode === 'messages') {
        const [msg, meta] = payload as [AIMessageChunk | ToolMessage, any]
        if (msg instanceof AIMessageChunk && typeof msg.content === 'string' && msg.content) {
          send({ type: 'delta', text: msg.content, node: String(meta?.langgraph_node ?? '?') }) // token 帧：pa onText(delta) 同款
        } else if (msg instanceof ToolMessage) {
          send({ type: 'tool', name: msg.name ?? '(tool)', result: String(msg.content).slice(0, 300) }) // 工具帧：完成时才发（pa onToolCall 同款粒度）
        }
      } else if (mode === 'custom') {
        send({ type: 'custom', ...((payload ?? {}) as object) }) // custom 通道：旁路事件原样进帧
      }
    }
    send({ type: 'done', ms: Date.now() - t0 })
  } catch (e) {
    send({ type: 'done', error: String(e) }) // 出错也收口（前端 reader 等 done 解除阻塞）
  }
  res.end()
  console.log(`[s8] 完成 · ${Date.now() - t0}ms`)
})

server.listen(PORT, () => console.log(`[s8] SSE 桥就绪 → http://localhost:${PORT}（Ctrl+C 停）`))
