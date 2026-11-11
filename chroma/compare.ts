// 练习 7 · 三路检索对比实验：纯 BM25（线上同款代码）vs 纯向量（Chroma）vs RRF 融合
// 回答一个问题：个人知识库加向量通道，值不值。
//
// 用法：先起 chroma 服务（yarn chroma），仓库根目录跑 `node chroma/compare.ts`
// BM25 路直接 import 线上的 rag.ts——同语言同代码，不是复刻，对比结果即接入预期

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ChromaClient } from 'chromadb'
import OpenAI from 'openai'
import 'dotenv/config'
import { bm25Search } from '../personal-agent/core/rag.ts'

// ---------- 嵌入（与 helloworld.ts 同款） ----------
const embedClient = new OpenAI({
  apiKey: process.env.LLM_API_KEY || '',
  baseURL: process.env.LLM_EMBED_BASE_URL || 'https://ark.cn-beijing.volces.com/api/coding/v3',
})
const EMBED_MODEL = process.env.LLM_EMBED_MODEL || 'doubao-embedding-vision-251215'
async function embed(texts: string[]): Promise<number[][]> {
  const r = await embedClient.embeddings.create({ model: EMBED_MODEL, input: texts })
  return r.data.sort((a, b) => a.index - b.index).map((d) => d.embedding) // 按 index 回填，不赌返回序
}

// ---------- 语料：kb.json 是事实源，Chroma 只是本实验的可重建索引 ----------
const kbFile = fileURLToPath(new URL('../personal-agent/data/rag/kb.json', import.meta.url))
const kb = JSON.parse(fs.readFileSync(kbFile, 'utf8')) as {
  docs: { id: string; name: string; createdAt: string; chunks: string[] }[]
}
const flat = new Map<string, { docName: string; text: string }>()
for (const d of kb.docs) d.chunks.forEach((text, i) => flat.set(`${d.id}:${i}`, { docName: d.name, text }))

// ---------- 灌库（实验专用集合 kb_exp）：条数与语料一致就复用（省嵌入调用），不一致删了重建 ----------
// 边缘情况：语料内容变了但块数恰好没变——会复用到旧向量，手动删 kb_exp 集合重跑即可
const client = new ChromaClient({ host: 'localhost', port: 8000 })
const keys = [...flat.keys()]
const ensureCollection = () =>
  client.getOrCreateCollection({
    name: 'kb_exp',
    metadata: { 'hnsw:space': 'cosine' },
    embeddingFunction: null, // 预计算路线：嵌入一律自带
  })
let col = await ensureCollection()
if ((await col.count()) !== keys.length) {
  await client.deleteCollection({ name: 'kb_exp' }).catch(() => {})
  col = await ensureCollection()
  for (let i = 0; i < keys.length; i += 10) { // 方舟 embedding 单批上限 10 条
    const batch = keys.slice(i, i + 10)
    const texts = batch.map((k) => flat.get(k)!.text)
    await col.upsert({
      ids: batch,
      documents: texts,
      metadatas: batch.map((k) => {
        const [docId, chunkIndex] = k.split(':')
        return { docId, chunkIndex: Number(chunkIndex), docName: flat.get(k)!.docName }
      }),
      embeddings: await embed(texts),
    })
  }
  console.log(`灌库完成：${keys.length} 个 chunk\n`)
} else {
  console.log(`复用已有索引：${keys.length} 个 chunk（语料没变，跳过嵌入）\n`)
}

// ---------- 查询集 ----------
// 改述式：问法故意不挨笔记原文措辞（BM25 主场之外）；实体式：专名/哈希/工具名（向量盲区）
// expect = 预期命中 chunk 应含的标记，数组 = 命中任意一个即算对
const QUERIES: { kind: '改述' | '实体'; q: string; expect: string[] }[] = [
  // ---- 改述组：字面重叠越小，越考验语义 ----
  { kind: '改述', q: '口味上喜欢什么，怕不怕辣', expect: ['爱吃甜'] },
  { kind: '改述', q: '长对话怎么省掉重复计算的推理开销', expect: ['前缀完全一致', 'Prompt Caching = KV Cache'] },
  { kind: '改述', q: '语言模型的训练分哪几个阶段', expect: ['训练三段论'] },
  { kind: '改述', q: '为什么大模型数不清 strawberry 里有几个 r', expect: ['字母级盲区'] },
  { kind: '改述', q: '检索为什么不能只靠语义、还要配字面匹配', expect: ['低频专名在向量空间里挤作一团'] },
  // ---- 实体组：精确串，BM25 主场 ----
  { kind: '实体', q: 'MRR 是什么意思', expect: ['Mean Reciprocal Rank'] },
  { kind: '实体', q: 'MediaRecorder 录音格式踩过什么坑', expect: ['MediaRecorder'] },
  { kind: '实体', q: 'ReAct 烧 token 的根因和对策', expect: ['ReAct token 经济学'] },
  { kind: '实体', q: 'tesseract 语言包被墙怎么解决的', expect: ['jsdelivr'] },
  { kind: '实体', q: '10dc446 这个提交做了什么', expect: ['10dc446'] },
]

// ---------- 三路与融合 ----------
/** RRF：只用名次不用分数——BM25 分越大越好、cosine 距离越小越好，方向量纲免疫 */
function rrf(lists: string[][], k = 60): { key: string; score: number }[] {
  const scores = new Map<string, number>()
  for (const list of lists)
    list.forEach((key, rank) => scores.set(key, (scores.get(key) ?? 0) + 1 / (k + rank + 1)))
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, score]) => ({ key, score }))
}

const TOPN = 5
const rankOf = (lane: string[], expect: string[]): number | null => {
  for (let i = 0; i < lane.length; i++) {
    const hit = flat.get(lane[i])
    if (hit && expect.some((m) => hit.text.includes(m))) return i + 1
  }
  return null
}
const label = (key: string): string => {
  const h = flat.get(key)
  return h ? `${h.docName.slice(0, 12)}#${key.split(':')[1]}` : key
}
const show = (r: number | null) => (r == null ? '  ×未中' : `  第${r}名`)

// ---------- 跑分 ----------
type Lane = 'BM25' | '向量' | 'RRF'
const stats: Record<Lane, { 改述: number[]; 实体: number[] }> = {
  BM25: { 改述: [], 实体: [] },
  向量: { 改述: [], 实体: [] },
  RRF: { 改述: [], 实体: [] },
}

for (const { kind, q, expect } of QUERIES) {
  // BM25 路：线上同款
  const bm25Lane = bm25Search(q, kb.docs, TOPN).map((h) => `${h.docId}:${h.chunkIndex}`)
  // 向量路
  const res = await col.query({ queryEmbeddings: await embed([q]), nResults: TOPN })
  const vecLane = res.ids?.[0] ?? []
  // RRF 路
  const rrfLane = rrf([bm25Lane, vecLane]).slice(0, TOPN).map((x) => x.key)

  const ranks: Record<Lane, number | null> = {
    BM25: rankOf(bm25Lane, expect),
    向量: rankOf(vecLane, expect),
    RRF: rankOf(rrfLane, expect),
  }
  for (const lane of ['BM25', '向量', 'RRF'] as Lane[]) stats[lane][kind].push(ranks[lane] ?? TOPN + 1)

  console.log(`[${kind}] ${q}`)
  console.log(
    `  BM25${show(ranks.BM25)} | 向量${show(ranks.向量)} | RRF${show(ranks.RRF)}   ` +
      `BM25top3:[${bm25Lane.slice(0, 3).map(label).join(', ')}] ` +
      `向量top3:[${vecLane.slice(0, 3).map(label).join(', ')}]`,
  )
}

// ---------- 汇总：top3 命中率 + 平均名次（未中记 TOPN+1=6） ----------
console.log('\n======== 汇总（top3 命中率 / 平均名次，越低越好；未中记 6） ========')
console.log('路线   | 改述组(5)      | 实体组(5)')
for (const lane of ['BM25', '向量', 'RRF'] as Lane[]) {
  const f = (arr: number[]) => `${arr.filter((r) => r <= 3).length}/5 命中 · 均名次 ${(arr.reduce((s, r) => s + r, 0) / arr.length).toFixed(1)}`
  console.log(`${lane.padEnd(6)} | ${f(stats[lane].改述)} | ${f(stats[lane].实体)}`)
}
