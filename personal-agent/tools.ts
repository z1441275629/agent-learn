// 工作台的具体工具面（注册表）。通用循环在 core/agent.ts；这里只定义「这个产品有哪些工具」。
//
// 只读工具（risk:'read'，自动放行）：
//   - get_time：回答「今天/现在」类问题的锚点——模型对当前时间永远是无知的，别让它猜
//   - search_kb：模型自主检索知识库——比固定自动注入强在可以换关键词多查几次（多跳问题），
//     且「要不要查」由模型判断；工具模式下自动注入关闭，避免同一内容双份进上下文
// 写入工具（risk:'write'，循环层确认门批准才跑）：
//   - remember：把用户明确要记的事实写进长期记忆（课程 07 的 A 路线）——参数原文
//     会出现在确认卡上，人批的才是账上的（PITFALLS #39：派生内容不得未经批准长命于源头）
//   - forget：删一条记忆——text 必须与系统提示里的记忆原文完全一致，不许模型自由发挥
//   - add_note：存一条笔记进知识库（search_kb 的写侧对偶）

import { newId, type MemoryStore } from './core/memories.ts'
import type { ToolDef } from './core/agent.ts'
import type { KbStore } from './core/rag.ts'

export function builtinTools(deps: { kb: KbStore; memories: MemoryStore }): ToolDef[] {
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
        // chatterGate:false——要不要查由模型决定，寒暄闸不替它把关（「组会」单关键词也放行）
        const hits = await deps.kb.search(query, 3, { chatterGate: false })
        if (!hits.length) return '知识库中没有检索到相关内容。'
        return hits.map((h, i) => `[${i + 1}]《${h.docName}》（相关度 ${h.score.toFixed(2)}）\n${h.text}`).join('\n\n')
      },
    },
    {
      name: 'remember',
      description:
        '把一条关于用户的持久事实写入长期记忆（跨会话生效）。只在用户明确表达「记住这个」时调用；调用后用户会在确认卡上自行批准，不需要你先口头确认。text 用一句话陈述事实本身，不要夹带解释。',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: '要记住的事实，一句话' } },
        required: ['text'],
      },
      risk: 'write',
      run: async (args) => {
        const text = String(args?.text ?? '').trim()
        if (!text) return JSON.stringify({ error: 'text 不能为空' })
        if (text.length > 300) return JSON.stringify({ error: '单条记忆太长（>300 字），拆成更短的事实' })
        let existed = false
        // mutate：读改写全程串行——与后台抽取钩子共用 memories.json，不许在窗口里互相覆盖
        await deps.memories.mutate((entries) => {
          existed = entries.some((e) => e.text === text)
          if (existed) return entries
          const iso = new Date().toISOString()
          return [...entries, { id: newId(), text, createdAt: iso, updatedAt: iso }]
        })
        return existed ? '这条记忆已经存在，无需重复记录。' : `已记住：${text}`
      },
    },
    {
      name: 'forget',
      description:
        '从长期记忆中删除一条记忆。系统提示里列出了当前全部记忆——要删哪条，就把那条记忆的原文一字不差地传给 text。用户明确要求「忘记/删掉某条记忆」时必须调用本工具执行：不调用、记忆就不会真的消失，不要只用文字声称已删除；调用后由用户在确认卡上批准，不需要你再口头向用户确认一遍。',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: '要删除的记忆原文（与系统提示里的条目完全一致）' } },
        required: ['text'],
      },
      risk: 'write',
      run: async (args) => {
        const text = String(args?.text ?? '').trim()
        if (!text) return JSON.stringify({ error: 'text 不能为空' })
        let found = false
        await deps.memories.mutate((entries) => {
          found = entries.some((e) => e.text === text)
          return found ? entries.filter((e) => e.text !== text) : entries
        })
        return found ? `已忘记：${text}` : `没有找到这条记忆（text 必须与记忆原文完全一致）：${text.slice(0, 60)}`
      },
    },
    {
      name: 'add_note',
      description:
        '把一段内容作为新笔记存入用户的个人知识库（之后可用 search_kb 检索到）。用户明确要求「存到笔记/记到知识库」时调用；text 是笔记正文，title 是简短标题。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '笔记标题，简短（如「青竹项目要点」）' },
          text: { type: 'string', description: '笔记正文' },
        },
        required: ['text'],
      },
      risk: 'write',
      run: async (args) => {
        const text = String(args?.text ?? '').trim()
        if (!text) return JSON.stringify({ error: 'text 不能为空' })
        const title = String(args?.title ?? '').trim() || `对话笔记 ${new Date().toISOString().slice(0, 10)}`
        const doc = await deps.kb.add(title, text)
        return `已存入知识库：《${doc.name}》（${doc.chunkCount} 块），之后可用 search_kb 检索。`
      },
    },
  ]
}
