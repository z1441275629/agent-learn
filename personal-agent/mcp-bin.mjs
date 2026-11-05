#!/usr/bin/env node
// pa-mcp 全局命令：把个人工作台 MCP server 暴露成一行命令，供任何 MCP 客户端 / 机器使用。
// in-process 直接跑（不再 spawn 子进程）：stdio 管道继承在 Windows 上有怪癖——子进程
// stdout 会丢响应；同进程跑，stdin/stdout 就是命令自己的，协议通道天然干净。
// 数据目录缺省随 config.ts 落到 personal-agent/data——从任何 cwd 跑都指向同一份库。
import { main } from './mcp-server.ts'

main()
