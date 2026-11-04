// 后端入口：组装 app、监听端口、收信号退出。
// 默认只绑 127.0.0.1——个人工具不暴露局域网（要手机用再 PA_HOST=0.0.0.0；注意 http://局域网IP
// 不是 secure context，浏览器剪贴板 API 会不可用，UI 有 execCommand 兜底）。
//
// 跑法：node personal-agent/server.ts   →  http://127.0.0.1:8798（server.ts 是指向这里的薄入口）
// 数据目录：PA_DATA_DIR（默认 personal-agent/data，sessions/ 在里面）
import { terminateOcr } from '../ocr.ts'
import { MODELS } from '../models.ts'
import { createApp } from './app.ts'
import { browser, config } from './state.ts'

const PORT = Number(process.env.PA_PORT || 8798)
const HOST = process.env.PA_HOST || '127.0.0.1'

const server = createApp().listen(PORT, HOST, () => {
  console.log(`[personal-agent] 工作台 → http://${HOST}:${PORT}`)
  console.log(`[personal-agent] 数据目录 → ${config.dataDir}（PA_DATA_DIR 可改）`)
  console.log(
    `[personal-agent] 模型：${MODELS.map((m) => `${m.label}=${m.model}${m.vision ? '(视觉)' : ''}`).join(' · ')}`,
  )
})

// Ctrl+C 收 worker（tesseract 的 wasm worker 不 terminate 会留一个子线程；
// 无头 Chromium 同理——不 close 会留浏览器进程树）
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await terminateOcr()
    await browser?.close()
    server.close()
    process.exit(0)
  })
}
