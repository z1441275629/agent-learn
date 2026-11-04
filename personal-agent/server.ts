// 个人 Agent 工作台 · 服务端薄入口
//
// 实现在 server/（Koa 后端项目：state 共享单件 / http 小件 / chat-service 对话域 / routes/ 各域路由）。
// 保留这个文件 = 保留 `node personal-agent/server.ts` 的历史跑法——README、E2E、产线启动命令都指它。
//
// 路由一览（都在 server/routes/）：
//   /api/chat(+confirm) —— agent 对话：文本+图片+文本附件，流式 SSE，工具循环+确认门
//   /api/sessions       —— 会话账本：列表/详情/图片；对话状态在服务端，刷新/重启后可恢复
//   /api/memories /api/kb —— 长期记忆与知识库的查看/删除
//   /api/asr            —— 大模型语音转写（MediaRecorder 整段上传）
//   /api/ocr            —— 截图取字：本地 tesseract 或视觉 LLM 两条路线
import './server/index.ts'
