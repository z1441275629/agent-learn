// 模块 15 第一层：手写 MCP server（stdio 传输 · JSON-RPC 2.0 · 换行分隔）。
// 手写优先：我们只用协议面的四个形状（initialize / notifications/initialized /
// tools/list / tools/call），不引 SDK——所有形状照 2025-06-18 规范抄（stdio 换行分帧、
// stdout 只准走协议消息、版本协商「支持则回显否则回自己最新」、错误两层：未知工具/参数
// 非法=JSON-RPC 错误，执行失败=isError 结果），规范原文已核对，不凭记忆。
//
// 定位：把工作台能力外露给 Claude Code 等 MCP 客户端——从 MCP 使用者变供给者。
// 复用产品核心模块（core/rag、browser）但不经过 HTTP、不 import server/state
// （那个会拉起整套服务端单件）——MCP 进程是独立的工具供给方，数据目录共享。
// v1 刻意只外露只读工具（kb_search / browser_read / browser_inspect）：写侧工具在
// 工作台里有确认门，MCP 侧还没有对应的审批语义，先不给。
// browser_inspect 在这里直接返回 image 内容块——Claude 自己就是多模态，感知交给
// 客户端模型（工作台内则是视觉档子调用，同一能力的两种分工对照）。

import readline from 'node:readline'
import path from 'node:path'
import { loadConfig } from './core/config.ts'
import { createKbStore } from './core/rag.ts'
import { assertNavigableUrl, createBrowserReader, formatConsoleSection, formatPageForModel, type BrowserReader } from './browser.ts'

const SERVER_INFO = { name: 'personal-agent', title: '个人 Agent 工作台', version: '0.1.0' }
const INSTRUCTIONS =
  '个人工作台的工具：kb_search 检索用户个人知识库（BM25，问「用户写过/记过什么」先用它）；' +
  'browser_read 无头浏览器读网页正文与可操作元素；browser_inspect 页面体检（截图+控制台报错）。全部只读。'

// ---------- 协议核心（纯逻辑，进程无关——探针零成本覆盖） ----------

export type McpContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

export interface McpTool {
  name: string
  title?: string
  description: string
  /** JSON Schema（object） */
  inputSchema: Record<string, unknown>
  run: (args: any) => Promise<{ content: McpContent[]; isError?: boolean }>
}

/** 我们支持的协议修订版（新→旧）；协商规则：请求的版本支持就回显，否则回我们最新版 */
export const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']

/** 版本协商：支持则回显，否则回自己支持的最新版（规范允许且 SHOULD） */
export function pickProtocolVersion(requested: unknown): string {
  return typeof requested === 'string' && SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0]
}

/** 必填参数在门口检查（规范：invalid arguments = JSON-RPC -32602，不是执行错误） */
export function missingRequired(schema: Record<string, unknown>, args: any): string | null {
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : []
  for (const key of required) {
    const v = args?.[key]
    if (v === undefined || v === null || v === '') return key
  }
  return null
}

export interface McpServerHandle {
  handleLine(line: string): void
  readonly initialized: boolean
}

/**
 * 协议服务器（io 注入）：send 负责把消息写出去（真进程里是 stdout 单行 JSON）。
 * 协议错误与执行错误严格分层：未知方法/未知工具/参数缺失 → JSON-RPC error；
 * 工具内部抛错 → isError:true 的正常结果（模型能读到原因并调整，连接不断）。
 */
export function createMcpServer(opts: { send: (o: unknown) => void; tools: McpTool[] }): McpServerHandle {
  const { send, tools } = opts
  const byName = new Map(tools.map((t) => [t.name, t]))
  let initialized = false
  const ok = (id: unknown, result: unknown) => send({ jsonrpc: '2.0', id, result })
  const err = (id: unknown, code: number, message: string) => send({ jsonrpc: '2.0', id, error: { code, message } })

  return {
    get initialized() {
      return initialized
    },
    handleLine(line: string) {
      const trimmed = line.trim()
      if (!trimmed) return
      let msg: any
      try {
        msg = JSON.parse(trimmed)
      } catch {
        return err(null, -32700, 'Parse error')
      }
      if (!msg || typeof msg.method !== 'string') return // 响应/怪形状：不是给我们的请求，忽略
      const isNotification = msg.id === undefined || msg.id === null
      switch (msg.method) {
        case 'initialize':
          ok(msg.id, {
            protocolVersion: pickProtocolVersion(msg.params?.protocolVersion),
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
            instructions: INSTRUCTIONS,
          })
          return
        case 'notifications/initialized':
          initialized = true
          return // 通知不回包
        case 'tools/list':
          ok(msg.id, {
            tools: tools.map((t) => ({
              name: t.name,
              ...(t.title ? { title: t.title } : {}),
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          })
          return
        case 'tools/call': {
          const tool = byName.get(String(msg.params?.name ?? ''))
          if (!tool) return err(msg.id, -32602, `Unknown tool: ${String(msg.params?.name ?? '')}`)
          const args = msg.params?.arguments ?? {}
          const missing = missingRequired(tool.inputSchema, args)
          if (missing) return err(msg.id, -32602, `Invalid arguments: missing required "${missing}"`)
          // 执行错误是「已应答的调用结果」——喂回模型，协议与连接都不受影响
          tool
            .run(args)
            .then((r) => ok(msg.id, { content: r.content, isError: r.isError === true }))
            .catch((e) =>
              ok(msg.id, {
                content: [{ type: 'text', text: `工具执行失败：${e instanceof Error ? e.message : String(e)}` }],
                isError: true,
              }),
            )
          return
        }
        case 'ping':
          ok(msg.id, {})
          return
        default:
          if (!isNotification) err(msg.id, -32601, `Method not found: ${msg.method}`)
          return
      }
    },
  }
}

// ---------- 工具面（依赖注入，真进程里接真实现） ----------

export function makeMcpTools(deps: { kbSearch: (q: string) => Promise<string>; browser?: BrowserReader }): McpTool[] {
  const tools: McpTool[] = [
    {
      name: 'kb_search',
      title: '个人知识库检索',
      description:
        '在用户的个人知识库（个人笔记，本地 BM25 检索）里按关键词找相关片段。问题涉及用户自己的记录、项目、安排、写过的东西时先用它；检索不到就直说没有，不要编造。',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: '检索关键词，尽量用笔记里可能出现的原词' } },
        required: ['query'],
      },
      run: async (args) => ({ content: [{ type: 'text', text: await deps.kbSearch(String(args?.query ?? '').trim()) }] }),
    },
  ]
  if (deps.browser) {
    tools.push(
      {
        name: 'browser_read',
        title: '读网页',
        description:
          '无头浏览器打开网页，等 JS 渲染完读正文（SPA 也读得到），返回标题/最终地址/正文与「可操作元素」索引。url 省略 = 读当前已打开的页面。只读，不能点击或输入。',
        inputSchema: {
          type: 'object',
          properties: { url: { type: 'string', description: '要打开的网页完整地址（http/https）；省略 = 读当前页' } },
          required: [],
        },
        run: async (args) => {
          const url = String(args?.url ?? '').trim()
          if (url) assertNavigableUrl(url) // 抛错 → isError 结果（守门与工作台同一份）
          return { content: [{ type: 'text', text: formatPageForModel(await deps.browser!.read(url || undefined)) }] }
        },
      },
      {
        name: 'browser_inspect',
        title: '页面体检',
        description:
          '开发调试：打开（或就地检查）网页并截图（图片直接返回，你能看到）+ 自本次加载起的控制台消息（JS 报错/警告/失败请求/HTTP 4xx5xx）。分析页面为什么不对、白屏、报错时用它。',
        inputSchema: {
          type: 'object',
          properties: { url: { type: 'string', description: '要体检的网页地址；省略 = 体检当前页' } },
          required: [],
        },
        run: async (args) => {
          const url = String(args?.url ?? '').trim()
          if (url) assertNavigableUrl(url)
          const page = await deps.browser!.inspect(url || undefined)
          const text = `《${page.title}》\n${page.url}\n\n${formatConsoleSection(page.console)}`
          // 截图去掉 dataURL 前缀 → MCP image 内容块（base64 裸数据）
          const b64 = page.screenshot.slice(page.screenshot.indexOf(',') + 1)
          return { content: [{ type: 'image', data: b64, mimeType: 'image/png' }, { type: 'text', text }] }
        },
      },
    )
  }
  return tools
}

// ---------- 进程入口：stdin 行 → 协议核心 → stdout 单行 JSON ----------

function main() {
  const config = loadConfig()
  const kb = createKbStore(config.dataDir)
  const browser = process.env.PA_BROWSER === '0' ? undefined : createBrowserReader()
  const kbSearch = async (query: string) => {
    if (!query) return 'query 为空：请给检索关键词。'
    const hits = await kb.search(query, 3, { chatterGate: false })
    if (!hits.length) return '知识库中没有检索到相关内容。'
    return hits.map((h, i) => `[${i + 1}]《${h.docName}》（相关度 ${h.score.toFixed(2)}）\n${h.text}`).join('\n\n')
  }
  const tools = makeMcpTools({ kbSearch, browser })

  const write = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`) // 单行、无内嵌换行（规范硬性要求）
  const server = createMcpServer({ send: write, tools })
  process.stderr.write(`[mcp] personal-agent 工具 ${tools.length} 个 · 数据目录 ${config.dataDir}\n`)

  const rl = readline.createInterface({ input: process.stdin })
  rl.on('line', (line) => server.handleLine(line))
  // stdio 关停语义：客户端关掉 stdin = 会话结束——收掉浏览器进程树再退出
  rl.on('close', () => {
    browser
      ?.close()
      .catch(() => {})
      .finally(() => process.exit(0))
  })
}

// 直跑判定：被 import（探针/E2E 复用纯函数）不拉起 stdio 循环，只有作为入口时才启动
if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) main()