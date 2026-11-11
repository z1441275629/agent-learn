import { ChromaClient } from 'chromadb'
import OpenAI from 'openai'
import 'dotenv/config'

const apiKey = process.env.LLM_API_KEY || ''
const EMBED_MODEL = process.env.LLM_EMBED_MODEL || 'doubao-embedding-vision-251215'
const EMBED_BASE_URL = process.env.LLM_EMBED_BASE_URL || 'https://ark.cn-beijing.volces.com/api/coding/v3'

const embedClient = new OpenAI({ apiKey, baseURL: EMBED_BASE_URL })

export async function embed(texts: string[]) {
  const response = await embedClient.embeddings.create({
    model: EMBED_MODEL,
    input: texts,
  })
  return response.data.map((item) => item.embedding)
}

// 3.x：path 选项已弃用，改用 host/port（另有 ssl 选项）
const client = new ChromaClient({ host: 'localhost', port: 8000 })

// 旧 notes 集合是带着「default EF」记录建的（上次跑时没声明 null），删了重建才干净；
// 顺带让脚本可反复重跑（练习 3 换 upsert 后这行就可以去掉了）
// await client.deleteCollection({ name: 'notes' }).catch(() => {})

// 建集合（已存在则复用）。⚠️ 距离度量在这里定死，事后改不了，只能新建集合重灌
// embeddingFunction: null = 显式声明「本集合不挂嵌入函数，嵌入一律自带」（预计算路线）；
// 不写的话 3.x 会给集合记一个 default EF，之后每次操作都刷
// 「Please install @chroma-core/default-embed」警告（无害但吵）
const col = await client.getOrCreateCollection({
  name: 'notes',
  metadata: { 'hnsw:space': 'cosine' }, // 默认是 l2！文本语义检索一般用 cosine
  embeddingFunction: null,
})

var res: any

const docs = [
  '今天和产品对齐了新版需求，砍掉了导出功能',
  'HNSW 是一种近似最近邻索引，用跳表式的多层图做检索',
  '组会提到李露露负责新版运营位',
]
// const metas = [{ src: '日报' }, { src: '技术笔记' }, { src: '组会' }]

// // 增：ids 必须唯一，撞了会报错；要幂等就用 upsert。embeddings 用 §5 的 helper 算
// res = await col.add({ ids: ['a1', 'a2', 'a3'], documents: docs, metadatas: metas, embeddings: await embed(docs) })

// // 查（语义）：queryEmbeddings 传自己嵌好的查询向量
const q = await embed(['需求评审聊了啥'])
// res = await col.query({ queryEmbeddings: q, nResults: 3,
//   include: ['documents', 'metadatas', 'distances'] })
// // ⚠️ 返回的是嵌套数组：外层对应每个查询，内层才是命中——取 [0]；TS 类型如实标了可空，用 ?. 兜
// const hitDocs = res.documents?.[0] ?? []
// const hitDists = res.distances?.[0] ?? []
// const hitMetas = res.metadatas?.[0] ?? []
// hitDocs.forEach((doc, i) =>
//   console.log(`${hitDists[i]?.toFixed(4)}  [${(hitMetas[i] as { src?: string })?.src}]  ${doc}`))
// 查（不带语义，纯取回）：get / peek / count
// res = await col.get({ ids: ['a1'] })              // 按 id 取
// res = await col.get({ where: { src: '组会' } })    // 按元数据过滤取
// res = await col.peek({ limit: 2 })                 // 随便看两条
// res = await col.count()                            // 条数

// 改：update 只改已存在的 id（不存在的静默跳过）；upsert = 有则改无则插（幂等脚本用它）
// ⚠️ 没挂 EF 的集合里，改文本 = 自己重嵌 + documents/embeddings 一起传
const next = '今天和产品对齐了新版需求（更新：导出功能保留）'
// res = await col.update({ ids: ['a1'], documents: [next], embeddings: await embed([next]) })
res = await col.upsert({ ids: ['a1', 'a4'], documents: [next, '新笔记'], embeddings: await embed([next, '新笔记']) })

// // 删
await col.delete({ ids: ['a4'] }) // 按 id
// await col.delete({ where: { src: '组会' } })  // 按元数据批量删
// await client.deleteCollection({ name: 'notes' })  // 整集合删（重灌用）

// metas 加上 days 字段
const metas = [
  { src: '日报', days: 1 },
  { src: '技术笔记', days: 10 },
  { src: '组会', days: 3 },
]

// add 换 upsert——同 id 重跑不报错，metadata 也会被更新（有则改无则插）
res = await col.upsert({ ids: ['a1', 'a2', 'a3'], documents: docs, metadatas: metas, embeddings: await embed(docs) })

// res = await col.query({ queryEmbeddings: q, where: { src: '技术笔记' } })                       // 等值
// res = await col.query({ queryEmbeddings: q, where: { src: { $eq: '技术笔记' } } })
// res = await col.query({ queryEmbeddings: q, where: { days: { $lt: 7 } } })                       // 范围
res = await col.query({
  queryEmbeddings: q,
  where: {
    // 组合
    $and: [{ src: { $eq: '技术笔记' } }, { days: { $lt: 7 } }],
  },
})
res = await col.query({
  queryEmbeddings: q,
  where: {
    // 组合
    $or: [{ src: { $eq: '技术笔记' } }, { days: { $lt: 7 } }],
  },
})
res = await col.query({
  queryEmbeddings: q,
  where: {
    // 组合
    $and: [{ src: { $eq: '技术笔记' } }, { days: { $gt: 7 } }],
  },
})
// res = await col.get({ whereDocument: { $contains: 'HNSW' } })          // 按原文包含过滤（非语义）

// res = await col.count()
console.log('结果：', res)
