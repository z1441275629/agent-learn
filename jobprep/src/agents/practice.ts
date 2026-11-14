// 陪练 agent（P1 核心件）：抽题 → interrupt 等人作答 → 判官批改（锚定参考答案）→ 记录/错题轮换 → 固定 N 题 → 弱点小结
// 图语义：
//   START → start_session（每场重置轮次；fresh input 必经，interrupt resume 不经——重放只发生在挂起节点）
//         → pick_question（错题优先重出+未做均匀轮换，纯函数可测）→ ask（interrupt 暂停等人）
//         → grade（判官结构化批改 + custom 事件外发）→ 条件边：round>=N ? summarize : pick_question
// 判官纪律（#67）：温度 0；批改必须锚定题库参考答案（判官 prompt 只做要点比对，不做知识发挥）
// 事件（custom 通道，#76 的 getWriter() 姿势）：picked / graded / summary
import { StateGraph, START, END, Annotation, interrupt, getWriter } from '@langchain/langgraph'
import { ChatOpenAI } from '@langchain/openai'
import * as z from 'zod'
import { env } from '../env.ts'
import type { BankQuestion } from '../bank/loader.ts'

// ── 判官 ──
export const GradeSchema = z.object({
  score: z.number().min(0).max(2).describe('0 未命中要点 / 1 部分命中 / 2 面试可用'),
  hits: z.array(z.string()).describe('答中的要点（短语）'),
  misses: z.array(z.string()).describe('遗漏的关键点（短语）'),
  comment: z.string().describe('一句话点评，面试官口吻，直接'),
})
export type Grade = z.infer<typeof GradeSchema>

export interface Judge {
  grade(input: { question: string; reference: string; answer: string }): Promise<Grade>
}

export function createLlmJudge(): Judge {
  const llm = new ChatOpenAI({
    model: env.model,
    apiKey: env.apiKey,
    configuration: { baseURL: env.baseURL },
    temperature: 0, // 判定节点锁参（#67）
  })
  const structured = llm.withStructuredOutput(GradeSchema)
  return {
    async grade({ question, reference, answer }) {
      const r = await structured.invoke([
        ['system', ['你是技术面试判官，只做要点比对不做知识发挥：', '参考答案里的关键点，用户回答讲到什么程度；', '讲到=hit，完全没讲=miss；措辞不同但意思在就算讲到；', '评分克制——关键点齐且理解对才给 2，沾边给 1，没讲到给 0。'].join('\n')],
        ['human', `题目：\n${question}\n\n参考答案：\n${reference}\n\n用户回答：\n${answer}`],
      ])
      return GradeSchema.parse(r)
    },
  }
}

// ── 抽题（纯函数，vitest 直测）──
export interface PickState {
  askedIds: string[]
  wrongIds: string[]
}
/** 错题优先（排除刚问过的那题）→ 未做过的均匀随机 → 都没了就全库随机 */
export function pickQuestion(bank: BankQuestion[], s: PickState): BankQuestion {
  const asked = new Set(s.askedIds)
  const last = s.askedIds.at(-1)
  const wrongPool = bank.filter((q) => s.wrongIds.includes(q.id) && q.id !== last && !asked.has(q.id))
  const pool = wrongPool.length ? wrongPool : bank.filter((q) => !asked.has(q.id))
  const from = pool.length ? pool : bank
  return from[Math.floor(Math.random() * from.length)]!
}

// ── 状态 ──
export interface RoundResult {
  id: string
  source: string
  score: number
  misses: string[]
}

const PracticeState = Annotation.Root({
  sessionId: Annotation<string>({ reducer: (_a, b) => b, default: () => '' }),
  round: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }),
  answer: Annotation<string>({ reducer: (_a, b) => b, default: () => '' }),
  current: Annotation<BankQuestion | null>({ reducer: (_a, b) => b, default: () => null }),
  askedIds: Annotation<string[]>({ reducer: (_a, b) => b, default: () => [] }),
  wrongIds: Annotation<string[]>({ reducer: (_a, b) => b, default: () => [] }),
  results: Annotation<RoundResult[]>({ reducer: (_a, b) => b, default: () => [] }),
})

export function createPracticeGraph(opts: { judge: Judge; bank: BankQuestion[]; rounds?: number; checkpointer?: unknown }) {
  const rounds = opts.rounds ?? 5
  return new StateGraph(PracticeState)
    .addNode('start_session', () => ({ round: 0 })) // fresh input 必经；resume 从挂起节点重放，不重置
    .addNode('pick_question', (s) => {
      const q = pickQuestion(opts.bank, s)
      getWriter()?.({ event: 'picked', id: q.id, source: q.source, round: s.round + 1, of: rounds, kind: q.kind, tag: q.tag })
      return { current: q, askedIds: [...s.askedIds, q.id] }
    })
    .addNode('ask', (s) => {
      const q = s.current!
      // 暂停等人作答：interrupt 载荷即题面（服务端读快照转给前端）；responseSchema 保证空答当场炸不落库（S5 验证）
      const answer = interrupt(
        { question: q.question, id: q.id, source: q.source, kind: q.kind },
        { responseSchema: z.string().min(1) },
      )
      return { answer: String(answer) }
    })
    .addNode('grade', async (s) => {
      const q = s.current!
      const g = await opts.judge.grade({ question: q.question, reference: q.answer, answer: s.answer })
      getWriter()?.({ event: 'graded', id: q.id, score: g.score, hits: g.hits, misses: g.misses, comment: g.comment })
      const stillWrong = g.score < 2
      return {
        results: [...s.results, { id: q.id, source: q.source, score: g.score, misses: g.misses }],
        wrongIds: stillWrong ? [...new Set([...s.wrongIds, q.id])] : s.wrongIds.filter((x) => x !== q.id),
        round: s.round + 1,
      }
    })
    .addNode('summarize', (s) => {
      const bySource = new Map<string, { n: number; got: number }>()
      for (const r of s.results) {
        const e = bySource.get(r.source) ?? { n: 0, got: 0 }
        bySource.set(r.source, { n: e.n + 1, got: e.got + r.score / 2 })
      }
      const summary = [...bySource].map(([src, v]) => `${src} ${v.got.toFixed(1)}/${v.n}`).join('；')
      getWriter()?.({ event: 'summary', summary, wrongCount: s.wrongIds.length, results: s.results })
      return {}
    })
    .addEdge(START, 'start_session')
    .addEdge('start_session', 'pick_question')
    .addEdge('pick_question', 'ask')
    .addEdge('ask', 'grade')
    .addConditionalEdges('grade', (s) => (s.round >= rounds ? 'summarize' : 'pick_question'), ['summarize', 'pick_question'])
    .addEdge('summarize', END)
    .compile({ checkpointer: opts.checkpointer as never })
}
