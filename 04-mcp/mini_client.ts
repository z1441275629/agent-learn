// 模块 4 主任务：手写极简 MCP 客户端（裸 JSON-RPC over stdio，不用 SDK）
//
// 为什么要手写：SDK 会把协议藏起来，用 SDK 的人永远"会用但不懂"；
// 裸写一遍握手你就永久拥有"协议层"的面试话语权。
//
// stdio 传输的协议就三条规矩：
//   1. 封帧：每条消息 = 一行 JSON + "\n"
//   2. 请求/响应靠 id 配对；通知（notification）没有 id，也不等响应
//   3. 日志必须走 stderr——stdout 是协议专用通道
//
// 运行约定：从项目根目录跑（npm run m4 或 node 04-mcp/mini_client.ts），
// 因为下面用相对路径 "04-mcp/server.ts" 定位 server。
import { spawn } from 'node:child_process'
import readline from 'node:readline'

const PROTOCOL_VERSION = '2025-06-18'

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void }

class McpStdioClient {
	private child: any = null
	private nextId = 1
	private pending = new Map<number, Pending>()

	// 底层管道（给你写好的）：启动 server 子进程，逐行解析它的 stdout。
	// 安全说明：参数全部为字面量且 shell:false，命令不经过 shell，无注入面。
	private start() {
		this.child = spawn('node', ['04-mcp/server.ts'], {
			stdio: ['pipe', 'pipe', 'inherit'],
			shell: false,
			cwd: process.cwd(),
		})
		const rl = readline.createInterface({ input: this.child.stdout })
		rl.on('line', (line: string) => {
			if (!line.trim()) return
			const msg = JSON.parse(line)
			if (msg.id !== undefined && this.pending.has(msg.id)) {
				const p = this.pending.get(msg.id)!
				this.pending.delete(msg.id)
				if (msg.error) p.reject(new Error(`${msg.error.message} (code ${msg.error.code})`))
				else p.resolve(msg.result)
			}
			// 没有 id 的是 server 发来的通知/日志，本 demo 忽略
		})
	}

	// 发请求（给你写好的）：带 id，等配对的响应回来
	private request(method: string, params: object): Promise<any> {
		const id = this.nextId++
		this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
		return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
	}

	// 发通知（给你写好的）：没有 id，不等响应
	private notify(method: string, params: object = {}) {
		this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
	}

	// TODO 1：握手 connect()
	//   ① this.start() 启动子进程
	//   ② request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {},
	//        clientInfo: { name: "mini-client", version: "1.0.0" } })
	//      console.log 对方的 serverInfo——看看对面是谁
	//   ③ notify("notifications/initialized")
	//   思考（面试必考）：②是请求、③为什么只是通知？
	//   （②要等对方返回能力集才能继续；③只是"我准备好了"的状态宣告，无需回应）
	async connect(): Promise<void> {
		// throw new Error("TODO 1：实现握手");
		this.start()
		this.request('initialize', {
			protocolVersion: PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: 'mini-client', version: '1.0.0' },
		})
		this.notify('notifications/initialized')
	}

	// TODO 2：列工具 listTools()
	//   request("tools/list", {})，逐个打印 name + description
	//   思考：这份列表和模块 1 里你手写的 TOOLS 数组是什么关系？
	//   （它就是"说明书"，将来一样会被转成 function calling 喂给模型）
	async listTools(): Promise<void> {
		// throw new Error('TODO 2：实现 tools/list')
		const toolsRes = await this.request('tools/list', {})
		// console.log('工具列表：' + JSON.stringify(toolsRes, null, 2))
		toolsRes.tools.forEach((tool: any) => {
			console.log(`工具名：${tool.name}, 描述: ${tool.description}`)
		})
	}

	// TODO 3：调工具 callTool(name, args)
	//   request("tools/call", { name, arguments: args })，打印返回的 content
	async callTool(name: string, args: object): Promise<void> {
		// throw new Error('TODO 3：实现 tools/call')
		const res = await this.request('tools/call', { name, arguments: args })
		console.log('工具调用结果：' + JSON.stringify(res, null, 2))
	}
}

// ---------- 主流程（不用动） ----------
const client = new McpStdioClient()
await client.connect()
await client.listTools()
await client.callTool('disk_usage', { path: 'E:/workspace' })
await client.callTool('top_files', { dir: 'E:/workspace/ai-agent-lab', top: 3 })
await client.callTool('get_os_info', {})
console.log('\n全部通过。下一步：把这个 server 接进 ZCode（验收）')
