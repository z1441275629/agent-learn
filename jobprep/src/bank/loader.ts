// 题库装载：把弹药库变成可考的题
// 源①：仓库根 reviews/*.md 的「## 3. 面试题」与「## 4. 参考答案」按序号配对（8 篇全部此结构）
// 源②：PITFALLS.md 每条目转「排障题」——症状即题面，根因+修法即参考答案
// 反目标纪律：题目必须可溯源——每题元数据带 source 文件与条目号，判官 prompt 也会引用它
import * as fs from 'node:fs'
import * as path from 'node:path'
import { REPO_ROOT } from '../env.ts'

export interface BankQuestion {
  id: string
  kind: 'qa' | 'pitfall'
  source: string
  question: string
  answer: string
  /** qa 题的类型标签（概念/实现），从题面「（概念）」前缀提取 */
  tag?: string
}

/** 解析单篇 review：§3 题目与 §4 答案按序号配对（条目可多行，吃到下一个编号行为止） */
export function parseReviewMd(name: string, text: string): BankQuestion[] {
  const section = (heading: RegExp): string => {
    const m = text.match(heading)
    if (!m || m.index === undefined) return ''
    const rest = text.slice(m.index + m[0].length)
    const stop = rest.search(/^#{2,3} /m)
    return stop === -1 ? rest : rest.slice(0, stop)
  }
  const numbered = (sec: string): Map<number, string> => {
    const out = new Map<number, string>()
    const matches = [...sec.matchAll(/^(\d+)[.、]\s*(.+)$/gm)]
    matches.forEach((m, i) => {
      const n = Number(m[1])
      const start = (m.index ?? 0) + m[0].length
      const end = i + 1 < matches.length ? matches[i + 1].index : sec.length
      out.set(n, (m[2] + sec.slice(start, end)).trim())
    })
    return out
  }
  const qs = numbered(section(/^## 3\..*$/m))
  const as = numbered(section(/^## 4\..*$/m))
  const out: BankQuestion[] = []
  for (const [n, q] of qs) {
    const a = as.get(n)
    if (!a) continue // 只有题没有答案的（编号错位）不收——宁可少不可错
    const tag = q.startsWith('（概念') || q.includes('（概念') ? '概念' : q.includes('（实现') ? '实现' : undefined
    out.push({ id: `${name}#${n}`, kind: 'qa', source: `${name}.md`, question: q, answer: a, tag })
  }
  return out
}

/** 解析 PITFALLS：每条 ## N. 转一道排障题（症状→怎么定位和修） */
export function parsePitfallsMd(text: string): BankQuestion[] {
  return text
    .split(/^## (?=\d+\.)/m)
    .slice(1)
    .map((entry): BankQuestion | null => {
      const head = entry.match(/^(\d+)\.\s*(.+)$/m)
      if (!head) return null
      const [, num, title] = head
      const field = (label: string) => entry.match(new RegExp(`^- ${label}：\\s*(.*)$`, 'm'))?.[1] ?? ''
      const symptom = field('症状')
      const cause = field('根因')
      const fix = field('修法')
      const principle = field('原则')
      const cleanTitle = title.split('（')[0].trim()
      const answer = [cause && `根因：${cause}`, fix && `修法：${fix}`, principle && `原则：${principle}`].filter(Boolean).join('\n')
      if (!answer) return null
      const question = symptom
        ? `排障题：${symptom.trim()}——你怎么定位根因、怎么修？`
        : `PITFALLS #${num}「${cleanTitle}」的核心教训是什么？`
      return { id: `P${num}`, kind: 'pitfall' as const, source: 'PITFALLS.md', question, answer }
    })
    .filter((q): q is BankQuestion => q !== null)
}

export function loadBank(dirs?: { reviews?: string; pitfalls?: string }): BankQuestion[] {
  const reviewsDir = dirs?.reviews ?? path.join(REPO_ROOT, 'reviews')
  const pitPath = dirs?.pitfalls ?? path.join(REPO_ROOT, 'PITFALLS.md')
  const bank: BankQuestion[] = []
  for (const f of fs.readdirSync(reviewsDir).filter((x) => x.endsWith('.md')).sort()) {
    bank.push(...parseReviewMd(f.replace(/\.md$/, ''), fs.readFileSync(path.join(reviewsDir, f), 'utf8')))
  }
  if (fs.existsSync(pitPath)) bank.push(...parsePitfallsMd(fs.readFileSync(pitPath, 'utf8')))
  return bank
}
