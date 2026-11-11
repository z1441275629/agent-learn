// 工具检索网关（行业叫 tool search / lazy tool loading，MCP 官方 2025 Tool Search 扩展同型）：
// 外部 MCP 工具的定义默认不进请求——模型先经 search_tools 元工具按需发现，命中的定义
// 「解锁」进后续轮次的工具面。省的是每轮请求里 N 份定义的 token，解锁成本只是一跳检索。
//
// 为什么 skills 能「名字+一句话」常驻提示而工具不行：use_skill 的调用格式固定（知道名字
// 就会调），SKILL.md 全文是数据；工具的参数 schema 各不相同——schema 是接口签名，拿不到
// 就无法生成合法调用。所以目录不进系统提示，进检索器（BM25 over name+description，
// 复用 core/rag 的同款分词与打分）；「货架摘要」（名字+一句话）放 search_tools 自己的
// description 里——模型看得见有什么，才知道要不要搜、搜什么。
//
// 解锁集是进程级：解锁过就一直进请求直到重启。定义常驻的成本远小于全目录常驻，
// 会话级回收对个人工具是过度设计。风险分级不变：解锁只是「可见」，write 工具照走确认门。
import type { ToolDef } from './core/agent.ts'
import { bm25Search } from './core/rag.ts'

export interface ToolSearchGateway {
  /** 元工具本体（常驻基础面） */
  searchTool: ToolDef
  /** 已解锁的外部工具（循环每轮来取） */
  unlockedTools(): ToolDef[]
}

/** 工具目录行：名字 + 描述首行（货架摘要，进 search_tools 的 description） */
const catalogLine = (t: ToolDef): string => {
  const first = t.description.split('\n')[0].replace(/^\[mcp:[^\]]+\]\s*/, '')
  return `- ${t.name}：${first.slice(0, 80)}`
}

export function createToolSearch(external: ToolDef[]): ToolSearchGateway {
  const byName = new Map(external.map((t) => [t.name, t]))
  const unlocked = new Set<string>()

  // BM25 语料适配：每个工具一条「文档」（name + description），复用 rag 的分词与 Okapi 打分
  const corpus = external.map((t, i) => ({
    id: String(i),
    name: t.name,
    createdAt: '',
    chunks: [`${t.name}\n${t.description}`],
  }))

  const searchTool: ToolDef = {
    name: 'search_tools',
    description:
      `按需检索外部工具的完整定义（含参数 schema）并解锁使用。当前可发现的外部工具：\n` +
      external.map(catalogLine).join('\n') +
      `\n命中即解锁——解锁后可像普通工具一样直接调用；没找到就换关键词再试。`,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '想做什么或想用什么工具；自然语言或工具名皆可' },
      },
      required: ['query'],
    },
    risk: 'read', // 只读目录：解锁不执行任何东西，write 工具照旧过确认门
    run: async (args: any) => {
      const query = String(args?.query ?? '')
      const hits = bm25Search(query, corpus, 5)
      if (hits.length === 0) {
        return '没有匹配的外部工具。换个说法再试一次；确实没有就直接回答，不要编造工具。'
      }
      const found = hits.map((h) => byName.get(external[Number(h.docId)].name)!).filter(Boolean)
      for (const t of found) unlocked.add(t.name)
      return (
        `已解锁 ${found.length} 个工具（本轮之后即可直接调用，参数 schema 如下）：\n\n` +
        found
          .map((t) => JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }, null, 2))
          .join('\n\n')
      )
    },
  }

  return {
    searchTool,
    unlockedTools: () => external.filter((t) => unlocked.has(t.name)),
  }
}
