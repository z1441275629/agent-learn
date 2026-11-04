// 工作台的具体工具面（注册表）。通用循环在 core/agent.ts；这里只定义「这个产品有哪些工具」。
//
// v1 只注册只读工具（risk:'read'，自动放行）：
//   - get_time：回答「今天/现在」类问题的锚点——模型对当前时间永远是无知的，别让它猜
//   - search_kb：模型自主检索知识库——比固定自动注入强在可以换关键词多查几次（多跳问题），
//     且「要不要查」由模型判断；工具模式下自动注入关闭，避免同一内容双份进上下文
// 写入类工具（如 remember）+ 确认门是下一层：risk:'write' 的工具循环层已预留，先不注册。

import type { ToolDef } from './core/agent.ts'
import type { KbStore } from './core/rag.ts'

export function builtinTools(deps: { kb: KbStore }): ToolDef[] {
  return [
    {
      name: 'get_time',
      description: '获取当前日期和时间。任何涉及「今天/现在/几点/几号」的问题先调用它，不要自己推算。',
      parameters: { type: 'object', properties: {}, required: [] },
      risk: 'read',
      run: async () => {
        const now = new Date()
        const weekdays = ['日', '一', '二', '三', '四', '五', '六']
        return `现在时间是 ${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日 星期${weekdays[now.getDay()]} ${now.toTimeString().slice(0, 8)}（本机时区）`
      },
    },
    {
      name: 'search_kb',
      description:
        '在用户的个人知识库（其上传的个人笔记）里按关键词检索，返回最相关的片段。问题涉及用户自己的记录、笔记、项目、安排时，先检索再回答；检索不到就说明没有，不要编造。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '检索关键词，尽量用笔记里可能出现的原词' } },
        required: ['query'],
      },
      risk: 'read',
      run: async (args) => {
        const query = String(args?.query ?? '').trim()
        if (!query) return JSON.stringify({ error: 'query 不能为空' })
        const hits = await deps.kb.search(query, 3)
        if (!hits.length) return '知识库中没有检索到相关内容。'
        return hits.map((h, i) => `[${i + 1}]《${h.docName}》（相关度 ${h.score.toFixed(2)}）\n${h.text}`).join('\n\n')
      },
    },
  ]
}
