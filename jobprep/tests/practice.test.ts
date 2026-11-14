// 图拓扑测试（零 LLM token：判官注入 fake；题库用合成 fixture）
// 覆盖：loader 解析（review 配对/PITFALLS 转排障题）、抽题策略（错题优先/排除刚问/耗尽回退）、
//       陪练图全循环（fresh→interrupt→resume→批改→下一题→…→summarize，MemorySaver 无 IO）
import { describe, it, expect } from 'vitest'
import { MemorySaver, Command } from '@langchain/langgraph'
import { parseReviewMd, parsePitfallsMd, type BankQuestion } from '../src/bank/loader.ts'
import { pickQuestion, createPracticeGraph, type Judge, type Grade } from '../src/agents/practice.ts'

// ── fixtures ──
const REVIEW_MD = `# 学习复盘 2099-99-99

## 1. 今天学了啥
- 忽略段

## 3. 面试题

1. （概念）StateGraph 的条件边是什么？
2. （实现）讲讲你的熔断中间件怎么计数？

### 无关子标题

## 4. 参考答案

1. 条件边是单路选择：函数返回下一个节点名。
2. wrapToolCall 里计数，超限拒发并注入降级指令。
   追加一行：拒发也要补 tool_call_id 回执。
`

const PITFALLS_MD = `## 999. 某坑标题（2099-99-99，某站）
- 症状：工具返回 [object Promise] 喂给模型
- 根因：invoke 契约是异步
- 修法：await + Promise.all
- 原则：静默强转比报错难排查

## 998. 无症状条目
- 原则：只有原则
`

const fakeBank: BankQuestion[] = [
  { id: 'q1', kind: 'qa', source: 'a.md', question: 'Q1', answer: 'A1' },
  { id: 'q2', kind: 'qa', source: 'a.md', question: 'Q2', answer: 'A2' },
  { id: 'q3', kind: 'qa', source: 'b.md', question: 'Q3', answer: 'A3' },
]

const fakeJudge = (score: number): Judge => ({
  async grade(): Promise<Grade> {
    return { score, hits: ['要点'], misses: score < 2 ? ['遗漏点'] : [], comment: '测试判官' }
  },
})

// ── loader ──
describe('题库 loader', () => {
  it('review §3/§4 按序号配对，答案吃多行', () => {
    const qs = parseReviewMd('2099-99-99', REVIEW_MD)
    expect(qs).toHaveLength(2)
    expect(qs[0]).toMatchObject({ id: '2099-99-99#1', kind: 'qa', source: '2099-99-99.md', tag: '概念' })
    expect(qs[0]!.question).toContain('条件边')
    expect(qs[1]!.answer).toContain('tool_call_id') // 多行答案吃到
    expect(qs[1]!.tag).toBe('实现')
  })

  it('PITFALLS 症状转排障题，根因/修法/原则进答案；无症状条目也收（教训题）', () => {
    const qs = parsePitfallsMd(PITFALLS_MD)
    expect(qs).toHaveLength(2)
    expect(qs[0]!.question).toContain('排障题')
    expect(qs[0]!.question).toContain('[object Promise]')
    expect(qs[0]!.answer).toContain('根因：')
    expect(qs[0]!.answer).toContain('原则：')
    expect(qs[1]!.id).toBe('P998')
  })
})

// ── 抽题策略 ──
describe('pickQuestion 抽题策略', () => {
  it('无历史时从全库均匀抽', () => {
    for (let i = 0; i < 20; i++) {
      expect(fakeBank.map((q) => q.id)).toContain(pickQuestion(fakeBank, { askedIds: [], wrongIds: [] }).id)
    }
  })

  it('错题优先：wrongIds 里有未问过的，只从错题池抽', () => {
    for (let i = 0; i < 20; i++) {
      const q = pickQuestion(fakeBank, { askedIds: ['q1'], wrongIds: ['q3'] })
      expect(q.id).toBe('q3')
    }
  })

  it('排除刚问过的那题（错题也要隔一轮再出）', () => {
    const q = pickQuestion(fakeBank, { askedIds: ['q1', 'q2'], wrongIds: ['q2'] })
    expect(q.id).not.toBe('q2') // q2 刚问过，错题池被排除后落到未做过池
  })

  it('全库问完回退全库随机（不空手）', () => {
    const q = pickQuestion(fakeBank, { askedIds: ['q1', 'q2', 'q3'], wrongIds: [] })
    expect(fakeBank.map((x) => x.id)).toContain(q.id)
  })
})

// ── 陪练图全循环（interrupt 拓扑）──
describe('陪练图拓扑循环', () => {
  it('fresh→挂起出题→resume 批改→循环→summarize（两题场，判官全给 1 分→错题进轮换）', async () => {
    const g = createPracticeGraph({ judge: fakeJudge(1), bank: fakeBank, rounds: 2, checkpointer: new MemorySaver() })
    const cfg = { configurable: { thread_id: 't-topo' } }

    // 第 1 题：fresh input 停在 ask 的 interrupt
    const r1 = (await g.invoke({ sessionId: 's' }, cfg)) as { __interrupt__?: Array<{ value: Record<string, unknown> }> }
    expect(r1.__interrupt__?.[0]?.value).toMatchObject({ kind: 'qa' })
    const q1 = r1.__interrupt__![0]!.value as { question: string; id: string }
    expect(q1.question).toMatch(/^Q\d$/)

    // 交卷 → 批改 → 第 2 题挂起
    const r2 = (await g.invoke(new Command({ resume: '我的回答1' }), cfg)) as typeof r1
    expect(r2.__interrupt__?.[0]?.value).toBeDefined()
    const q2 = r2.__interrupt__![0]!.value as { id: string }
    expect(q2.id).not.toBe(q1.id) // 抽题不重复

    // 再交卷 → 场终（无挂起，state 完整）
    const r3 = (await g.invoke(new Command({ resume: '我的回答2' }), cfg)) as {
      __interrupt__?: unknown[]
      results: Array<{ id: string; score: number }>
      round: number
      wrongIds: string[]
    }
    expect(r3.__interrupt__).toBeUndefined()
    expect(r3.results).toHaveLength(2)
    expect(r3.round).toBe(2)
    expect(r3.wrongIds).toEqual(expect.arrayContaining([q1.id])) // 1 分（<2）进错题轮换
  })

  it('满分批改把错题移出轮换（two-state 清除）', async () => {
    const g = createPracticeGraph({ judge: fakeJudge(2), bank: fakeBank, rounds: 1, checkpointer: new MemorySaver() })
    const cfg = { configurable: { thread_id: 't-topo2' } }
    await g.invoke({ sessionId: 's' }, cfg)
    const r = (await g.invoke(new Command({ resume: '满分回答' }), cfg)) as { wrongIds: string[]; results: unknown[] }
    expect(r.wrongIds).toHaveLength(0)
    expect(r.results).toHaveLength(1)
  })
})
