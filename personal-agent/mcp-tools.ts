// 外部 MCP server 工具接入：读项目根 .mcp.json，把每个 server 的工具翻译成本地 ToolDef。
// 主循环/确认门/工具帧零改动——远端工具在循环眼里和本地工具同形（翻译层，不是新循环）。
//
// 两种传输（条目里二选一）：
//   - stdio：command/args/env（Claude Code 同款字段；相对路径以 .mcp.json 所在目录为基准）
//   - streamable HTTP：url（MCP 2025-03-26 起的 HTTP 形态，单一端点 POST JSON-RPC）；
//     额外头放 headers（值支持 ${ENV_VAR} 引用环境变量——密钥别明文进仓库）。
//     旧式 SSE 传输（type:"sse"，GET /sse 拿端点再 POST）不支持，遇到明确报错跳过
//   协议实现：裸 JSON-RPC（stdio 同 04-mcp/mini_client.ts；HTTP 同为手写，与 mcp-server.ts 风格一致）
//
// 本仓扩展键（标准字段与 Claude Code 共用同一份文件，CC 忽略未知键）：
//   - risk：外部工具的风险等级是接入方的信任决策，协议里没有这个字段；缺省 'write' 走确认门
//   - timeoutMs：缺省 15s——远端卡死不能卡死 agent
//
// 纪律：指向自己的条目自动跳过（.mcp.json 与 Claude Code 共享，personal-agent 条目是给 CC 的）；
// 连不上/缺文件降级空表照常起服务——外部工具是增强不是依赖；PA_MCP=0 整体关闭。
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import type { ToolDef } from './core/agent.ts'

const PROTOCOL_VERSION = '2025-06-18'
const DEFAULT_TIMEOUT_MS = 15_000

/** 传输层最小接口：stdio / HTTP 归一到 request/notify，上层握手与工具翻译不感知差异 */
interface Transport {
  request(method: string, params: object): Promise<any>
  notify(method: string, params?: object): void
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void }

/** stdio 传输：启动子进程长持 + 请求/响应按 id 配对（mini_client 同款，加退出/spawn 失败兜底） */
class StdioTransport implements Transport {
  private child!: ChildProcessByStdio<Writable, Readable, null>
  private nextId = 1
  private pending = new Map<number, Pending>()

  private readonly cwd: string
  private readonly env: Record<string, string>

  constructor(cwd: string, env: Record<string, string>) {
    this.cwd = cwd
    this.env = env
  }

  start(cmd: string, args: string[]): void {
    this.child = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'inherit'],
      shell: false,
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
    })
    const rl = readline.createInterface({ input: this.child.stdout })
    rl.on('line', (line: string) => {
      if (!line.trim()) return
      let msg: any
      try {
        msg = JSON.parse(line)
      } catch {
        return // 坏行丢弃——stdout 是协议通道，server 想打日志应该走 stderr
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!
        this.pending.delete(msg.id)
        if (msg.error) p.reject(new Error(`${msg.error.message} (code ${msg.error.code})`))
        else p.resolve(msg.result)
      }
      // 无 id 的是通知（工具目录变更等）——个人工具不热更，重启生效
    })
    // server 退出/起不来：挂着没答的请求立刻失败，别傻等超时
    const failAll = (why: string | Error) => {
      for (const p of this.pending.values()) p.reject(why instanceof Error ? why : new Error(why))
      this.pending.clear()
    }
    this.child.on('close', () => failAll('MCP server 已退出'))
    this.child.on('error', (err) => failAll(err))
  }

  request(method: string, params: object): Promise<any> {
    const id = this.nextId++
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }

  notify(method: string, params: object = {}): void {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }
}

/**
 * Streamable HTTP 传输：所有消息 POST 到同一 url，响应体两种形态——
 * application/json 一条直接读；text/event-stream 在流式帧里等配对 id（期间夹的通知/别家响应跳过）。
 * initialize 响应头的 Mcp-Session-Id 自动回带到后续请求（会话由 server 分配，没有就不带）。
 * 每次请求独立收流：拿到配对响应即 cancel，不长期占连接（个人工具不需要 server→client 推送）
 */
class HttpTransport implements Transport {
  private nextId = 1
  private sessionId: string | null = null

  private readonly url: string
  private readonly headers: Record<string, string>
  private readonly timeoutMs: number

  constructor(url: string, headers: Record<string, string>, timeoutMs: number) {
    this.url = url
    this.headers = headers
    this.timeoutMs = timeoutMs
  }

  async request(method: string, params: object): Promise<any> {
    const id = this.nextId++
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
        ...this.headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      // signal 管到 body 读完：SSE 慢速读阶段同样受超时约束（和 stdio 路语义一致）
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (this.sessionId == null) {
      const sid = res.headers.get('mcp-session-id')
      if (sid) this.sessionId = sid
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const ctype = res.headers.get('content-type') ?? ''
    return ctype.includes('text/event-stream') ? this.readSse(res, id) : this.readJson(res)
  }

  private async readJson(res: Response): Promise<any> {
    const msg: any = await res.json()
    if (msg.error) throw new Error(`${msg.error.message} (code ${msg.error.code})`)
    return msg.result
  }

  private async readSse(res: Response, id: number): Promise<any> {
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true }).replace(/\r/g, '')
        let idx: number
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          // SSE 事件帧：data: 行拼起来才是完整 JSON（事件名等其余行不参与）
          const data = frame
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
            .join('')
          if (!data) continue
          let msg: any
          try {
            msg = JSON.parse(data)
          } catch {
            continue
          }
          if (msg.id === id) {
            if (msg.error) throw new Error(`${msg.error.message} (code ${msg.error.code})`)
            return msg.result
          }
        }
      }
      throw new Error('SSE 流结束前未等到配对响应')
    } finally {
      void reader.cancel()
    }
  }

  notify(method: string, params: object = {}): void {
    // 通知不等响应（204/202 都算送达）；失败自吞——通知丢了 server 会以协议错误显形
    void fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
        ...this.headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method, params }),
    }).catch(() => {})
  }
}

/** .mcp.json 单个 server 条目（stdio 与 HTTP 二选一；risk/timeoutMs/headers 是本仓扩展） */
export interface McpServerEntry {
  /** stdio 形态 */
  command?: string
  args?: string[]
  env?: Record<string, string>
  /** streamable HTTP 形态端点；与 command 二选一。旧式 type:"sse" 不支持 */
  url?: string
  type?: string
  /** 额外请求头（Authorization 等）；值支持 ${ENV_VAR} 引用环境变量——密钥别明文进仓库 */
  headers?: Record<string, string>
  /** 缺省 'write'（确认门）——没声明的外部工具按有副作用对待 */
  risk?: 'read' | 'write'
  timeoutMs?: number
}

/** headers 值里的 ${ENV_VAR} 替换成环境变量（支持内嵌，如 "Bearer ${MY_TOKEN}"；
 *  引用不存在保留原样——显式可见比静默空串好查） */
function resolveHeaders(headers: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    out[k] = v.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? `\${${name}}`)
  }
  return out
}

/** OpenAI function 名规则 [a-zA-Z0-9_-]{1,64}：server 键/工具名里可能有别的字符，统一洗一遍 */
const safeName = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, '_')

/** 读 .mcp.json 装载全部外部工具。任何失败都只影响对应 server（其余照常），方法级返回空表 */
export async function loadMcpTools(configPath?: string): Promise<ToolDef[]> {
  if (process.env.PA_MCP === '0') return []
  const file = configPath ?? path.resolve(import.meta.dirname, '..', '.mcp.json')
  let cfg: { mcpServers?: Record<string, McpServerEntry> }
  try {
    cfg = JSON.parse(await fs.promises.readFile(file, 'utf-8'))
  } catch {
    return [] // 没配/坏 JSON 都当没配
  }
  const root = path.dirname(file) // stdio 条目里的相对路径以 .mcp.json 所在目录为基准
  const tools: ToolDef[] = []
  for (const [key, entry] of Object.entries(cfg.mcpServers ?? {})) {
    // 指向自己的条目跳过：那条是给 Claude Code 的，自己连自己 = 凭空多 spawn 一个自己（工具全重复）
    if ((entry.args ?? []).some((a) => a.replace(/\\/g, '/').includes('personal-agent/mcp-server'))) {
      console.log(`[pa] mcp: 跳过「${key}」（指向自己——那条是给 Claude Code 的）`)
      continue
    }
    try {
      tools.push(...(await connectOne(key, entry, root)))
    } catch (err: any) {
      console.warn(`[pa] mcp: 「${key}」接入失败（跳过，其余照常）：${err?.message ?? err}`)
    }
  }
  return tools
}

/** 按条目形状选传输（url → HTTP；command → stdio），握手后翻译工具表 */
async function connectOne(key: string, entry: McpServerEntry, root: string): Promise<ToolDef[]> {
  const timeoutMs = entry.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const risk: 'read' | 'write' = entry.risk ?? 'write'

  let transport: Transport
  if (entry.type === 'sse') {
    throw new Error('旧式 SSE 传输不支持——换 streamable HTTP（去掉 type:"sse" 只留 url）')
  } else if (entry.url) {
    transport = new HttpTransport(entry.url, resolveHeaders(entry.headers), timeoutMs)
  } else if (entry.command) {
    const stdio = new StdioTransport(root, entry.env ?? {})
    stdio.start(entry.command, entry.args ?? [])
    transport = stdio
  } else {
    throw new Error('条目缺 url 或 command，无法接入')
  }

  const serverInfo: any = await transport.request('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'personal-agent', version: '1.0.0' },
  })
  transport.notify('notifications/initialized')
  const listed: any = await transport.request('tools/list', {})
  const remote: any[] = listed?.tools ?? []
  if (remote.length > 0) {
    console.log(`[pa] mcp: 「${key}」(${serverInfo?.serverInfo?.name ?? '?'}) 接入 ${remote.length} 个工具 [${risk}]`)
  }

  return remote.map((t) => ({
    // 前缀防撞本地工具名（同名 function 定义 OpenAI 会拒）；原名留在 description 里可追溯
    name: safeName(`mcp_${key}_${t.name}`).slice(0, 64),
    description: `[mcp:${key}] ${String(t.description ?? '')}`,
    // inputSchema 就是 JSON Schema、就是 function.parameters 的形状——恒等搬运
    parameters: t.inputSchema ?? { type: 'object', properties: {} },
    risk,
    // 不提供 describe：确认卡上显示参数原文（远端工具没有本地那套人话翻译器）
    run: async (args: any) => {
      try {
        const res: any = await Promise.race([
          transport.request('tools/call', { name: t.name, arguments: args ?? {} }),
          new Promise((_, reject) => setTimeout(() => reject(new Error(`超时 ${timeoutMs}ms`)), timeoutMs)),
        ])
        if (res?.isError) return `工具报错：${JSON.stringify(res.content ?? res)}`
        // content 数组拍平成字符串（ToolDef 约定 run 永远返回 string）；非 text 项占位
        const text = (res?.content ?? []).map((c: any) => (c.type === 'text' ? c.text : `[${c.type} 内容]`)).join('\n')
        return text || '(空结果)'
      } catch (err: any) {
        return `调用失败：${err?.message ?? err}` // 异常在工具层消化，循环不因远端挂掉断掉
      }
    },
  }))
}
