// 模块 4：你自己的第一个 MCP Server（官方 TypeScript SDK）
//
// 注意运行方式：MCP Server 不是"跑起来看"的程序——它是被客户端启动的子进程，
// 通过 stdio 用 JSON-RPC 通信。本模块的三种验证方式：
//   ① echo 一段 JSON-RPC 消息进去（我已验证可用，你不用做）
//   ② 你手写的 mini_client.ts 连它（你的主任务）
//   ③ 接进 ZCode，在 Agent 里调用你的工具（最终验收）
//
// 面试核心答案（动手前先记住）：
//   MCP 和 Function Calling 的关系：MCP Server 里的工具，最终还是转成 function
//   calling 喂给模型；MCP 解决的是"工具怎么接进来"的标准化问题（USB-C），
//   不是模型能力本身。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import os from 'node:os'


const server = new McpServer({ name: "lab-tools", version: "1.0.0" });

// 工具 1：磁盘占用 —— 真实数据，真实有用
server.registerTool("disk_usage", {
  title: "磁盘占用查询",
  description: "查询路径所在磁盘的总容量/已用/剩余（GB）。传入任意存在的路径即可。",
  inputSchema: { path: z.string().describe("任意存在的本地路径，如 E:/workspace") },
}, async ({ path: p }) => {
  const s = await fs.statfs(p);
  const gb = (n: number) => +((n * s.bsize) / 2 ** 30).toFixed(1);
  const total = gb(s.blocks);
  const free = gb(s.bavail);
  return {
    content: [{
      type: "text",
      text: JSON.stringify({ path: p, totalGB: total, usedGB: +(total - free).toFixed(1), freeGB: free }),
    }],
  };
});

// 工具 2：目录里最大的 N 个文件 —— 排查"磁盘被什么吃了"
server.registerTool("top_files", {
  title: "大文件排查",
  description: "递归列出某目录下最大的 N 个文件（目录很大时会稍慢）",
  inputSchema: {
    dir: z.string().describe("要扫描的目录"),
    top: z.number().default(5).describe("取前几个，默认 5"),
  },
}, async ({ dir, top }) => {
  const results: { file: string; mb: number }[] = [];
  async function walk(d: string) {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return; // 无权限/特殊目录直接跳过，不中断整体扫描
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) {
        const { size } = await fs.stat(full);
        results.push({ file: full, mb: +(size / 2 ** 20).toFixed(2) });
      }
    }
  }
  await walk(dir);
  results.sort((a, b) => b.mb - a.mb);
  return { content: [{ type: "text", text: JSON.stringify(results.slice(0, top), null, 2) }] };
});

// TODO（给你，5 分钟）：仿照上面注册第三个工具 get_os_info：
//   import os from "node:os"，返回 os.platform() / arch() / totalmem() / freemem() / hostname()
//   写完用 mini_client 的 tools/list 确认它出现——体会"注册即接入，零改动循环"
// 工具 3：获取操作系统信息
server.registerTool("get_os_info", {
  title: "获取操作系统信息",
  description: "返回当前操作系统的平台、架构、内存等信息",
  inputSchema: {},
}, async () => {
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        platform: os.platform(),
        arch: os.arch(),
        totalmem: os.totalmem(),
        freemem: os.freemem(),
        hostname: os.hostname()
      })
    }]
  };
});

// 关键规矩（面试考点）：stdio 传输下 stdout 是协议专用通道，
// 任何日志必须走 stderr，混进 stdout 就会毁掉客户端的 JSON 解析。
console.error("[lab-tools] MCP server starting on stdio...");
await server.connect(new StdioServerTransport());
