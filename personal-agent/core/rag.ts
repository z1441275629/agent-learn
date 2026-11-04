// 产品核心：个人知识库（RAG 的检索层）
//
// 课程 02 的 RAG 是纯向量召回；07 的对照实验实测过它的盲区——实体/专名查询
// （「李露露」「柳泉小学」）向量排序是浆糊，字面精确匹配才是 BM25 主场。
// 产品 v1 只上 BM25 一路：
//   - 零 API 成本、离线、确定性（同输入同结果——可探针、可回归）
//   - 个人笔记检索的高频形态是「我记得我写过 xxx」——实体/关键词查询，正好是 BM25 主场
//   - search() 是唯一入口：以后要语义召回，加向量通道走 RRF 融合即可（07 已验证的
//     升级路径），调用方零改动
//
// 语料 = 文档切块（约 500 字）；注入 = 构建请求时把命中片段塞进最后一条 user
// 消息（只进发送视图，不落会话账本——账本里永远是用户真实说过的话）。

import fs from 'node:fs/promises'
import path from 'node:path'

// ---------- 分词：CJK 二元组 + 英数连串（07 同款，查询/文档同一把刀） ----------
// '妻子李露露用999皮炎平' -> ['妻子','子李','李露','露露','露用','999','皮炎','炎平']
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  for (const run of [...text.matchAll(/[一-鿿]+|[a-z0-9]+/gi)].map((m) => m[0])) {
    if (/^[a-z0-9]+$/i.test(run)) {
      tokens.push(run.toLowerCase())
    } else if (run.length === 1) {
      tokens.push(run)
    } else {
      for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2))
    }
  }
  return tokens
}

// ---------- 切块：按行打包到上限，超长单行硬切（个人笔记按行组织，天然段落边界） ----------
export function chunkText(text: string, maxChars = 500): string[] {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim())
  const chunks: string[] = []
  let cur = ''
  const push = () => {
    if (cur.trim()) chunks.push(cur)
    cur = ''
  }
  for (const line of lines) {
    if (!line) continue
    // 超长单行（表格、粘贴的一整段）：按字符硬切，不假装它有段落结构
    const pieces = line.length > maxChars ? (line.match(new RegExp(`.{1,${maxChars}}`, 'g')) ?? []) : [line]
    for (const piece of pieces) {
      if (cur && cur.length + piece.length + 1 > maxChars) push()
      cur = cur ? `${cur}\n${piece}` : piece
    }
  }
  push()
  return chunks
}

// ---------- BM25（Okapi；k1/b 用 Elasticsearch 同款默认） ----------
export interface KbDocRecord {
  id: string
  name: string
  createdAt: string
  chunks: string[]
}

export interface KbHit {
  docId: string
  docName: string
  chunkIndex: number
  text: string
  score: number
}

/**
 * 语料 = 所有文档的所有切块（每块一个 BM25 文档）。
 * 零分过滤在源头做：一个词都没命中的块不进排名——短查询的字面噪音不给它出场机会。
 */
export function bm25Search(query: string, docs: KbDocRecord[], topK = 3): KbHit[] {
  const corpus: { doc: KbDocRecord; chunkIndex: number; text: string }[] = []
  for (const doc of docs) {
    doc.chunks.forEach((text, chunkIndex) => corpus.push({ doc, chunkIndex, text }))
  }
  if (!corpus.length) return []

  const docTokens = corpus.map((c) => tokenize(c.text))
  const N = corpus.length
  const avgdl = docTokens.reduce((sum, t) => sum + t.length, 0) / N
  if (!avgdl) return [] // 全空语料的除零守卫

  const df = new Map<string, number>()
  for (const tokens of docTokens) {
    for (const t of new Set(tokens)) df.set(t, (df.get(t) ?? 0) + 1)
  }

  const k1 = 1.5
  const b = 0.75
  const scored: KbHit[] = corpus.map((c, i) => {
    const tf = new Map<string, number>()
    for (const t of docTokens[i]) tf.set(t, (tf.get(t) ?? 0) + 1)
    const dl = docTokens[i].length
    let score = 0
    for (const q of new Set(tokenize(query))) {
      const f = tf.get(q)
      if (!f) continue // 本块没这个词 → 该项贡献 0；同时保证 df.get 必然取得到
      const dfv = df.get(q)!
      const idf = Math.log(1 + (N - dfv + 0.5) / (dfv + 0.5)) // +1 保证非负
      score += (idf * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * dl) / avgdl))
    }
    return { docId: c.doc.id, docName: c.doc.name, chunkIndex: c.chunkIndex, text: c.text, score }
  })

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b2) => b2.score - a.score)
    .slice(0, topK)
}

/** 命中片段 → 注入文本（明确告诉模型这是自动匹配，可能无关——不许它当圣旨） */
export function renderKbBlock(hits: KbHit[]): string {
  return (
    '【知识库参考】以下片段由关键词检索自动匹配，可能相关也可能无关，请自行判断是否使用：\n' +
    hits.map((h, i) => `[${i + 1}]《${h.docName}》\n${h.text}`).join('\n\n')
  )
}

/**
 * 把检索块塞进 messages 里最后一条 user 消息的开头（文本拼接或数组头插一个 text part）。
 * 返回新数组，不改入参——纯函数。
 */
export function withKbContext(messages: any[], block: string | null): any[] {
  if (!block) return messages
  const out = messages.map((m) => ({ ...m }))
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role !== 'user') continue
    if (typeof out[i].content === 'string') {
      out[i].content = `${block}\n\n${out[i].content}`
    } else if (Array.isArray(out[i].content)) {
      out[i].content = [{ type: 'text', text: block }, ...out[i].content]
    }
    break
  }
  return out
}

/** 查询是否值得检索：至少两个不同 token——「继续」「好的」这类寒暄不值得打扰索引 */
export function worthSearching(query: string): boolean {
  return new Set(tokenize(query)).size >= 2
}

// ---------- 存储：dataDir/rag/kb.json 单文件原子写（与会话/记忆同一套纪律） ----------
export interface KbDocSummary {
  id: string
  name: string
  createdAt: string
  chunkCount: number
}

export const MAX_KB_DOC_CHARS = 1_000_000 // 1MB 文本——个人笔记足够；更大的先拆分再传

export interface KbStore {
  readonly file: string
  list(): Promise<KbDocSummary[]>
  add(name: string, text: string): Promise<KbDocSummary>
  remove(id: string): Promise<boolean>
  search(query: string, topK?: number): Promise<KbHit[]>
}

export function createKbStore(dataDir: string): KbStore {
  const file = path.join(dataDir, 'rag', 'kb.json')

  const load = async (): Promise<{ version: number; docs: KbDocRecord[] }> => {
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'))
      if (parsed && Array.isArray(parsed.docs)) return { version: 1, docs: parsed.docs }
    } catch {
      // 不存在/损坏都当空库起——个人工具不能因为一个索引文件起不来
    }
    return { version: 1, docs: [] }
  }
  const persist = async (docs: KbDocRecord[]): Promise<void> => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    const tmp = file + '.tmp'
    await fs.writeFile(tmp, JSON.stringify({ version: 1, docs }))
    await fs.rename(tmp, file)
  }

  return {
    file,

    async list() {
      const { docs } = await load()
      return docs.map(({ id, name, createdAt, chunks }) => ({ id, name, createdAt, chunkCount: chunks.length }))
    },

    async add(name, text) {
      if (!name.trim()) throw Object.assign(new Error('文档名不能为空'), { code: 400 })
      if (!text.trim()) throw Object.assign(new Error('文档内容不能为空'), { code: 400 })
      if (text.length > MAX_KB_DOC_CHARS)
        throw Object.assign(new Error(`文档超过 ${MAX_KB_DOC_CHARS} 字上限，请先拆分`), { code: 413 })
      const { docs } = await load()
      const record: KbDocRecord = {
        id: newId(),
        name: name.trim().slice(0, 120),
        createdAt: new Date().toISOString(),
        chunks: chunkText(text),
      }
      docs.push(record)
      await persist(docs)
      return { id: record.id, name: record.name, createdAt: record.createdAt, chunkCount: record.chunks.length }
    },

    async remove(id) {
      const { docs } = await load()
      const next = docs.filter((d) => d.id !== id)
      if (next.length === docs.length) return false
      await persist(next)
      return true
    },

    async search(query, topK = 3) {
      if (!worthSearching(query)) return []
      const { docs } = await load()
      return bm25Search(query, docs, topK)
    },
  }
}

function newId(): string {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '_' + Math.random().toString(36).slice(2, 8)
}
