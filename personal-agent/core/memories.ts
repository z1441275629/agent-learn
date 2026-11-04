// 产品核心：跨会话长期记忆
//
// 课程模块 07 是全量学习版（索引 + 每事实一文件 + 向量查重 + BM25 混合检索）；
// 产品 v1 按日用场景收窄成「抽取钩子 + 单 JSON 库」：
//   - 写入 = 课程的 B 路线（回答完成后钩子抽取）。write_memory 工具（A 路线，
//     模型自主决定记什么）等工作台接上 agent loop/tools 再启用
//   - 去重/合并不做向量：抽取时把已有记忆整份喂给模型，由它输出更新后的完整列表，
//     代码侧只做守门（课程教训：模型输出 JSON 永远不可信——剥围栏、验形状、
//     「清空拒绝」防一次模型打嗝就把记忆全抹了）
//   - 注入 = 每轮 system 前缀全量带上：个人 agent 记忆量小（几十条），
//     全量注入比按需检索省一次工具往返；量大了再上 RAG（下一步）
//
// 存储：dataDir/memories.json 单文件 + 原子写（与会话账本同一套纪律）。

import fs from 'node:fs/promises'
import path from 'node:path'
import type OpenAI from 'openai'
import { renderMessagesForSummary } from './context.ts'

export interface MemoryEntry {
  id: string
  text: string
  createdAt: string
  updatedAt: string
}

export interface MemoryStore {
  readonly file: string
  list(): Promise<MemoryEntry[]>
  save(entries: MemoryEntry[]): Promise<void>
  remove(id: string): Promise<boolean>
  clear(): Promise<void>
}

export function createMemoryStore(dataDir: string): MemoryStore {
  const file = path.join(dataDir, 'memories.json')

  const loadDoc = async (): Promise<{ version: number; entries: MemoryEntry[] }> => {
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'))
      if (parsed && Array.isArray(parsed.entries)) return { version: 1, entries: parsed.entries }
    } catch {
      // 不存在/损坏都当空库——损坏时宁可从零开始也不让个人工具起不来
    }
    return { version: 1, entries: [] }
  }

  return {
    file,

    async list() {
      return (await loadDoc()).entries
    },

    async save(entries) {
      await fs.mkdir(path.dirname(file), { recursive: true })
      const tmp = file + '.tmp'
      await fs.writeFile(tmp, JSON.stringify({ version: 1, entries }, null, '\t'))
      await fs.rename(tmp, file)
    },

    async remove(id) {
      const { entries } = await loadDoc()
      const next = entries.filter((e) => e.id !== id)
      if (next.length === entries.length) return false
      await this.save(next)
      return true
    },

    async clear() {
      await this.save([])
    },
  }
}

/** 注入到每轮请求开头的 system 内容（全量列表——v1 量小，不上检索） */
export function memorySystemContent(entries: { text: string }[]): string {
  return `以下是关于用户的长期记忆（跨会话持续有效，回答时可自然使用，不要逐条复述）：\n${entries
    .map((e) => `- ${e.text}`)
    .join('\n')}`
}

// ---------- 抽取：提示词与解析 ----------

/** 抽取输入只给最近一轮：更早的轮在各自完成时已抽过，重复喂只会把过期事实再捞回来 */
export const EXTRACTION_SYSTEM_PROMPT = `你是记忆治理模块。根据【已有记忆】和【新对话】，输出这份记忆更新后的完整列表。
规则：
- 只记关于用户的持久事实、偏好、目标——判断标准：未来的对话还用得上吗？一次性的任务细节不记
- 用户明确说「记住」的必须记；明确说「忘记/删掉」的必须移除
- 已有记忆里的事实一条不能丢（除非被新对话更正，或用户要求删除）
- 同一事实冲突时以新对话为准（用户后说的覆盖先说的，如日期修正）
- 未受影响的条目原样保留，不要改写措辞——重复合并时新表述每轮都获胜会让用词慢慢漂移
- 时间一律写绝对日期（今天由用户提供），不要用「今年」「最近」这类相对表述
- 每条一句话以内
- 输出纯 JSON 字符串数组 ["...", "..."]，不要围栏、不要解释；没有可记的且已有记忆无需变动时，原样返回已有列表`

export function buildExtractionUserPrompt(existingTexts: string[], transcript: string, today: string): string {
  const parts = [`今天是 ${today}。`]
  parts.push(
    existingTexts.length ? `【已有记忆】\n${existingTexts.map((t) => `- ${t}`).join('\n')}` : '【已有记忆】\n（空）',
  )
  parts.push(`【新对话】\n${transcript}`)
  return parts.join('\n\n')
}

/** 模型输出 → 字符串数组。剥围栏、验形状；不合法返回 null（调用方大声报错，不许静默吞） */
export function parseMemoryList(raw: string | null | undefined): string[] | null {
  if (!raw) return null
  let text = raw.trim()
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  }
  if (text.startsWith('{')) return null // 对象形状（如 {"items":[]}）就是错的——别从里面抠数组硬救
  // 模型偶尔在数组前后垫一句解释——截取首个 [ 到最后一个 ] 之间再试一次
  if (!text.startsWith('[')) {
    const from = text.indexOf('[')
    const to = text.lastIndexOf(']')
    if (from >= 0 && to > from) text = text.slice(from, to + 1)
  }
  try {
    const parsed = JSON.parse(text)
    if (!Array.isArray(parsed)) return null
    // 有一个非字符串元素就是没听懂格式——整体拒绝，不做部分抢救（半套应用比丢弃更危险）
    if (!parsed.every((x) => typeof x === 'string')) return null
    const items = parsed.map((s) => s.trim()).filter(Boolean)
    return items.every((s) => s.length <= 300) ? items : null
  } catch {
    return null
  }
}

export interface MemoryDiff {
  entries: MemoryEntry[]
  added: string[]
  removed: string[]
}

/**
 * 完整列表重放的机械化落账：文本未变的条目沿用原 id/createdAt（措辞不动 = 同一条记忆），
 * 新文本发新 id，消失的删除。纯函数，探针覆盖。
 */
export function mergeMemoryList(existing: MemoryEntry[], nextTexts: string[], now = new Date()): MemoryDiff {
  const byText = new Map(existing.map((e) => [e.text, e]))
  const entries: MemoryEntry[] = nextTexts.map((text) => {
    const old = byText.get(text)
    if (old) return { ...old, updatedAt: old.updatedAt }
    const iso = now.toISOString()
    return { id: newId(now), text, createdAt: iso, updatedAt: iso }
  })
  const nextSet = new Set(nextTexts)
  return {
    entries,
    added: nextTexts.filter((t) => !byText.has(t)),
    removed: existing.filter((e) => !nextSet.has(e.text)).map((e) => e.text),
  }
}

/** 政策守门：已有记忆非空时拒绝「清空」式输出——一次模型打嗝不许抹掉全部记忆（真要清空走 UI） */
export function shouldAcceptExtraction(nextTexts: string[], existingCount: number): boolean {
  return nextTexts.length > 0 || existingCount === 0
}

export function newId(now = new Date()): string {
  return now.toISOString().slice(0, 19).replace(/[:T]/g, '-') + '_' + Math.random().toString(36).slice(2, 8)
}

export interface ExtractResult {
  texts: string[]
  promptTokens: number
  completionTokens: number
}

export async function extractMemories(
  client: OpenAI,
  model: string,
  existingTexts: string[],
  turn: { role: string; text?: string; images?: { name: string }[]; error?: string }[],
  options: { thinkingParams?: Record<string, unknown>; today?: string } = {},
): Promise<ExtractResult> {
  const transcript = renderMessagesForSummary(turn)
  const today = options.today ?? new Date().toISOString().slice(0, 10)
  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
      { role: 'user', content: buildExtractionUserPrompt(existingTexts, transcript, today) },
    ],
    temperature: 0.2,
    max_tokens: 1000,
    // 不传 tools：空数组在部分 API 是禁用、部分是报错（PITFALLS #25）
    ...(options.thinkingParams ?? {}),
  } as any)
  const raw = response.choices[0]?.message?.content ?? ''
  const texts = parseMemoryList(raw)
  if (texts === null) throw Object.assign(new Error(`抽取输出不合法（前 120 字：${raw.slice(0, 120)}）`), { code: 502 })
  return {
    texts,
    promptTokens: response.usage?.prompt_tokens ?? 0,
    completionTokens: response.usage?.completion_tokens ?? 0,
  }
}
