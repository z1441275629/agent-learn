// 练习 7 补充实验：裸实体查询（无任何语境词，专打向量盲区）
// 主实验的实体查询都带了上下文（如「10dc446 这个提交做了什么」），哈希本身在向量空间无意义，
// 但「提到哈希的那块」语境贴查询就能排第一。裸串才是 07 先验（实体=向量浆糊）的严格检验。
// 用法：kb_exp 集合已在（跑过 compare.ts），仓库根目录 node chroma/bare.ts

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ChromaClient } from 'chromadb'
import OpenAI from 'openai'
import 'dotenv/config'
import { bm25Search } from '../personal-agent/core/rag.ts'

const embedClient = new OpenAI({
  apiKey: process.env.LLM_API_KEY || '',
  baseURL: process.env.LLM_EMBED_BASE_URL || 'https://ark.cn-beijing.volces.com/api/coding/v3',
})
const EMBED_MODEL = process.env.LLM_EMBED_MODEL || 'doubao-embedding-vision-251215'
async function embed(texts: string[]): Promise<number[][]> {
  const r = await embedClient.embeddings.create({ model: EMBED_MODEL, input: texts })
  return r.data.sort((a, b) => a.index - b.index).map((d) => d.embedding)
}

const kbFile = fileURLToPath(new URL('../personal-agent/data/rag/kb.json', import.meta.url))
const kb = JSON.parse(fs.readFileSync(kbFile, 'utf8')) as {
  docs: { id: string; name: string; createdAt: string; chunks: string[] }[]
}
const flat = new Map<string, { docName: string; text: string }>()
for (const d of kb.docs) d.chunks.forEach((text, i) => flat.set(`${d.id}:${i}`, { docName: d.name, text }))

const client = new ChromaClient({ host: 'localhost', port: 8000 })
const col = await client.getOrCreateCollection({ name: 'kb_exp', embeddingFunction: null }) // 已灌好，只查

// 裸实体：只有串本身；李露露是负例（语料里没有，两路都该落空，验证评分器不瞎给分）
const QUERIES: { q: string; expect: string[] }[] = [
  { q: '10dc446', expect: ['10dc446'] },
  { q: 'MediaRecorder', expect: ['MediaRecorder'] },
  { q: 'jsdelivr', expect: ['jsdelivr'] },
  { q: 'GQA', expect: ['Grouped-Query Attention'] },
  { q: 'PPL', expect: ['Perplexity'] },
  { q: '李露露', expect: ['___不存在的负例___'] },
]

const flatText = (key: string) => flat.get(key)?.text ?? ''
const rankOf = (lane: string[], expect: string[]) => {
  for (let i = 0; i < lane.length; i++)
    if (expect.some((m) => flatText(lane[i]).includes(m))) return i + 1
  return null
}
const label = (key: string) => `${flat.get(key)?.docName.slice(0, 12)}#${key.split(':')[1]}`

let bm25Win = 0
let vecWin = 0
for (const { q, expect } of QUERIES) {
  const bm25Lane = bm25Search(q, kb.docs, 3).map((h) => `${h.docId}:${h.chunkIndex}`)
  const res = await col.query({ queryEmbeddings: await embed([q]), nResults: 3 })
  const vecLane = res.ids?.[0] ?? []
  const b = rankOf(bm25Lane, expect)
  const v = rankOf(vecLane, expect)
  if (expect[0].includes('不存在的负例')) {
    console.log(`[负例] ${q}  →  BM25:${b ?? '落空✓'} 向量:${v ?? '落空✓'}（都该落空）`)
    continue
  }
  if (b != null) bm25Win++
  if (v != null) vecWin++
  console.log(
    `[裸实体] ${q}  →  BM25:${b ?? '×未中'} 向量:${v ?? '×未中'}   ` +
      `BM25top3:[${bm25Lane.map(label).join(', ')}] 向量top3:[${vecLane.map(label).join(', ')}]`,
  )
}
console.log(`\n裸实体 top3 命中：BM25 ${bm25Win}/5 vs 向量 ${vecWin}/5`)
