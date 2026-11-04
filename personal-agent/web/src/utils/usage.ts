import type { ChatUsage } from '../types'

/** 服务商 usage → 一行可读文本（不认识/缺失的字段自动跳过，平台换了也不炸） */
export function formatUsage(u: ChatUsage): string {
  if (!u) return ''
  const parts: string[] = []
  if (u.prompt_tokens != null) parts.push(`prompt ${u.prompt_tokens}`)
  if (u.completion_tokens != null) parts.push(`completion ${u.completion_tokens}`)
  if (u.total_tokens != null) parts.push(`total ${u.total_tokens}`)
  const cached = u.prompt_tokens_details?.cached_tokens
  if (cached != null) parts.push(`缓存命中 ${cached}`)
  const reasoning = u.completion_tokens_details?.reasoning_tokens
  if (reasoning != null) parts.push(`推理 ${reasoning}`)
  return parts.join(' · ')
}
