// 外部 MCP server 工具接入：读项目根 .mcp.json，把每个 server 的工具翻译成本地 ToolDef。
// 主循环/确认门/工具帧零改动——远端工具在循环眼里和本地工具同形（翻译层，不是新循环）。
//
// 协议：裸 JSON-RPC over stdio（04-mcp/mini_client.ts 手写同款路线，与 mcp-server.ts 风格一致；
// SDK 在依赖里但本仓两边都是裸写，保持一致）。三条规矩：一行一帧 JSON、id 配对、日志走 stderr。
//
// .mcp.json 条目字段：command/args/env 是标准字段（与 Claude Code 共享同一份文件）；
// 本仓扩展两个键——risk（外部工具的风险等级是接入方的信任决策，协议里没有这个字段；
// 缺省 'write' 走确认门，声明 'read' 才自动放行）、timeoutMs（缺省 15s，远端卡死不能卡死 agent）。
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

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void }

/** 一个 server 的长连：启动子进程 + 请求/响应按 id 配对（mini_client 同款，加退出/失败兜底） */
class StdioClient {
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

/** .mcp.json 单个 server 条目（risk/timeoutMs 是本仓扩展，标准字段与 Claude Code 共用） */
export interface McpServerEntry {
  command: string
  args?: string[]
  env?: Record<string, string>
  /** 缺省 'write'（确认门）——没声明的外部工具按有副作用对待 */
  risk?: 'read' | 'write'
  timeoutMs?: number
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
  const root = path.dirname(file) // 条目里的相对路径以 .mcp.json 所在目录为基准
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

async function connectOne(key: string, entry: McpServerEntry, root: string): Promise<ToolDef[]> {
  const conn = new StdioClient(root, entry.env ?? {})
  conn.start(entry.command, entry.args ?? [])
  const serverInfo: any = await conn.request('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'personal-agent', version: '1.0.0' },
  })
  conn.notify('notifications/initialized')
  const listed: any = await conn.request('tools/list', {})
  const remote: any[] = listed?.tools ?? []
  if (remote.length > 0) {
    console.log(`[pa] mcp: 「${key}」(${serverInfo?.serverInfo?.name ?? '?'}) 接入 ${remote.length} 个工具 [${entry.risk ?? 'write'}]`)
  }

  const risk: 'read' | 'write' = entry.risk ?? 'write'
  const timeoutMs = entry.timeoutMs ?? DEFAULT_TIMEOUT_MS
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
          conn.request('tools/call', { name: t.name, arguments: args ?? {} }),
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
