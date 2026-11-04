// 产品核心：上下文预算与压缩
//
// 课程模块 06~09 的 ContextManager 是内存版的「双账本」；产品里会话是持久化的，
// 所以这里换成**可持久化摘要**：会话文档记 summary + summaryUntil，每次重建请求时
// 只发送「摘要 + 截止点之后的原文」——不重复摘要、进程重启也不丢。
//
// 三层防线（先便宜后贵）：
//   ① 源头：图片省略已在 chat.ts 做（旧图零 I/O 不读盘）
//   ② 有损压缩：旧轮 → LLM 摘要，摘要与截止点落盘
//   ③ 兜底：摘要失败/仍超预算 → 滑动窗口按整轮丢最旧，最新一轮永远保留
//
// token 估算是**决策阈值**，不是计费：中文≈1 token/字、英文≈4 字符/token；
// 图片按固定 1400 tokens/张估算——绝不能拿 dataURL 的 base64 长度算，
// 那会把一张图估成几万 token，预算永远爆。

import type OpenAI from 'openai'

export const IMAGE_TOKEN_ESTIMATE = 1400

const MESSAGE_OVERHEAD = 4

/** 粗估：非 ASCII 一律按 1 token/字（中文密度高），ASCII 4 字符/token */
export function estimateTokens(text: string): number {
  return (text || '').replace(/[^\x00-\xff]/g, 'xxxx').length / 4
}

/** content 可能是字符串，也可能是 [{type:'text'}|{type:'image_url'}]（多模态） */
export function contentTokens(content: unknown): number {
  if (typeof content === 'string') return estimateTokens(content)
  if (!Array.isArray(content)) return 0
  let total = 0
  for (const part of content as any[]) {
    if (part?.type === 'text') total += estimateTokens(String(part.text ?? ''))
    else if (part?.type === 'image_url') total += IMAGE_TOKEN_ESTIMATE
  }
  return total
}

export function messagesTokens(messages: { content?: unknown }[]): number {
  return messages.reduce((sum, m) => sum + contentTokens(m.content) + MESSAGE_OVERHEAD, 0)
}

/** 存储形状的消息（text + 图片引用）——图片不读文件，只按张数估 */
export function storedMessagesTokens(messages: { text: string; images: unknown[] }[]): number {
  return messages.reduce(
    (sum, m) => sum + estimateTokens(m.text) + m.images.length * IMAGE_TOKEN_ESTIMATE + MESSAGE_OVERHEAD,
    0,
  )
}

/**
 * 按轮分组：一条 user 开启一轮，后续 assistant/tool 消息归入该轮。
 * 边界落在轮与轮之间 = 语义完整（有问必有答）。开头的 assistant 没有归属，忽略。
 */
export function groupTurns<T extends { role: string }>(messages: T[]): T[][] {
  const turns: T[][] = []
  for (const message of messages) {
    if (message.role === 'user') turns.push([message])
    else turns[turns.length - 1]?.push(message)
  }
  return turns
}

export interface SplitPlan<T> {
  /** 最新几轮，原文保留 */
  retained: T[]
  /** 更早的轮，交给摘要 */
  summarize: T[]
}

/**
 * 保留策略：从最新一轮往回装，最多装到预算的一半（verbatim 区）；
 * 最新一轮无论多大都保留（否则正在进行的任务会被摘要掉）。
 */
export function splitForCompaction<T extends { role: string }>(
  messages: T[],
  options: { budgetTokens: number; tokenOfTurn: (turn: T[]) => number },
): SplitPlan<T> {
  const turns = groupTurns(messages)
  const half = options.budgetTokens / 2
  const retainedTurns: T[][] = []
  let used = 0
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]
    const tokens = options.tokenOfTurn(turn)
    if (retainedTurns.length === 0 || used + tokens <= half) {
      retainedTurns.unshift(turn)
      used += tokens
    } else {
      break
    }
  }
  const retainedCount = retainedTurns.length
  return {
    retained: retainedTurns.flat(),
    summarize: turns.slice(0, turns.length - retainedCount).flat(),
  }
}

/**
 * 兜底滑动窗口（轮粒度）：保留前 prefixCount 条（通常是摘要消息），
 * 然后从最新轮往回装；最新一轮永远保留，哪怕超预算。
 */
export function applyWindow(messages: any[], budgetTokens: number, prefixCount = 0): any[] {
  const prefix = messages.slice(0, prefixCount)
  const turns = groupTurns(messages.slice(prefixCount))
  let used = messagesTokens(prefix)
  const keep: any[][] = []
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]
    const tokens = messagesTokens(turn)
    if (keep.length === 0 || used + tokens <= budgetTokens) {
      keep.unshift(turn)
      used += tokens
    } else {
      break
    }
  }
  return [...prefix, ...keep.flat()]
}

export const DEFAULT_SUMMARY_PROMPT = `把以下对话压缩成摘要。必须保留：
- 用户的目标与偏好
- 已经做出的决定及依据
- 关键事实、数字、专名
- 尚未完成的事项
直接输出摘要正文，不要客套话、不要复述指令。`

/**
 * 存储消息 → 摘要输入文本。
 * 图片只写占位符：把 base64 塞给摘要模型既贵又没有意义（它看的是旧图，早该被省略）。
 */
export function renderMessagesForSummary(
  messages: { role: string; text?: string; images?: { name: string }[]; error?: string }[],
  maxCharsPerMessage = 4000,
): string {
  return messages
    .filter((m) => !m.error)
    .map((m) => {
      const role = m.role === 'user' ? '用户' : '助手'
      let text = (m.text ?? '').trim()
      if (text.length > maxCharsPerMessage) {
        const half = Math.floor(maxCharsPerMessage / 2)
        text = text.slice(0, half) + '\n…[截断]…\n' + text.slice(-half)
      }
      const images = m.images?.length ? `\n[图片 ${m.images.map((i) => i.name).join('、')} 未展开]` : ''
      return `${role}：${text}${images}`
    })
    .join('\n\n')
}

export interface SummarizeOptions {
  prompt?: string
  /** 平台思考开关参数（摘要不该付思考预算；由调用方按 LLM_THINKING_STYLE 传入） */
  thinkingParams?: Record<string, unknown>
  maxCharsPerMessage?: number
}

export interface SummarizeResult {
  summary: string
  promptTokens: number
  completionTokens: number
}

export async function summarizeConversation(
  client: OpenAI,
  model: string,
  messages: { role: string; text?: string; images?: { name: string }[]; error?: string }[],
  previousSummary: string | undefined,
  options: SummarizeOptions = {},
): Promise<SummarizeResult> {
  const transcript = renderMessagesForSummary(messages, options.maxCharsPerMessage)
  const userParts: string[] = []
  if (previousSummary) userParts.push(`【已有前情摘要】\n${previousSummary}`)
  userParts.push(`【需要合并的对话】\n${transcript}`)

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: options.prompt ?? DEFAULT_SUMMARY_PROMPT },
      { role: 'user', content: userParts.join('\n\n') },
    ],
    temperature: 0.2,
    max_tokens: 800,
    // 注意：不传 tools。空数组在部分 API 是禁用、部分是报错（PITFALLS #25）
    ...(options.thinkingParams ?? {}),
  } as any)
  const summary = (response.choices[0]?.message?.content ?? '').trim()
  if (!summary) throw Object.assign(new Error('摘要模型没有返回内容'), { code: 502 })
  return {
    summary,
    promptTokens: response.usage?.prompt_tokens ?? 0,
    completionTokens: response.usage?.completion_tokens ?? 0,
  }
}
