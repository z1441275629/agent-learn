// 知识库向量通道：Chroma 派生索引 + 嵌入 API（复用 09-harness/llm.ts 的 embedClient）。
//
// 定位（实验依据 chroma/chromadb-notes.md §12，69 chunk 三路实测）：
//   - 向量为主、BM25 补位——等权 RRF 被弱路噪声名次拖累，不做
//   - 检索增强不是依赖：chroma 没起/嵌入失败/索引损坏，一律自吞降级纯 BM25，绝不炸 search
//   - kb.json 是唯一事实源，本索引是可重建缓存：search 时条数对账，不平就整库重灌（自愈）
//
// 环境变量：PA_KB_VECTOR=0 整体关（回到纯 BM25）；PA_CHROMA_URL 缺省 http://localhost:8000
import { ChromaClient, type Collection } from 'chromadb'
import type OpenAI from 'openai'
import { embedClient, EMBED_MODEL } from '../09-harness/llm.ts'
import type { KbDocRecord, VectorHit, VectorLane } from './core/rag.ts'

// 方舟 embedding 单批上限 10 条（实验踩过：400 input limit exceeded）
const EMBED_BATCH = 10
// 连续失败熔断阈值：3 次后本进程内停用（重启复活）——服务没起时别让每次检索都白发失败请求
const TRIP_AFTER = 3

// 换嵌入模型 = 换集合（维度不同直接报错；按模型名分集合天然隔离，旧集合成了死数据可手删）
const collectionName = 'kb_' + EMBED_MODEL.replace(/[^a-z0-9-]/gi, '').slice(-40)

export function createVectorLane(embed: OpenAI = embedClient): VectorLane {
  const url = new URL(process.env.PA_CHROMA_URL || 'http://localhost:8000')
  const client = new ChromaClient({
    host: url.hostname,
    port: Number(url.port || 8000),
    ssl: url.protocol === 'https:',
  })

  let fails = 0
  let dead = false
  /** 失败记账：连续 TRIP_AFTER 次熔断；任何失败都只降级、不上抛 */
  function onFail(where: string, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err)
    fails += 1
    if (fails >= TRIP_AFTER) {
      dead = true
      console.warn(`[pa] 向量通道连续失败 ${fails} 次（最近：${where} ${msg}），本进程内停用——纯 BM25 运行，重启服务或检查 chroma（yarn chroma）`)
    } else {
      console.warn(`[pa] 向量通道失败（${where}：${msg}），本次降级纯 BM25`)
    }
  }

  async function embedAll(texts: string[]): Promise<number[][]> {
    const out: number[][] = []
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const r = await embed.embeddings.create({ model: EMBED_MODEL, input: texts.slice(i, i + EMBED_BATCH) })
      // 响应带 index，按它回填——不赌返回序和入参一致
      out.push(...r.data.sort((a, b) => a.index - b.index).map((d) => d.embedding))
    }
    return out
  }

  const collection = (): Promise<Collection> =>
    client.getOrCreateCollection({
      name: collectionName,
      metadata: { 'hnsw:space': 'cosine' }, // 文本语义检索用 cosine；默认 l2 是坑
      embeddingFunction: null, // 预计算路线：嵌入一律自带，忘传时响亮报错而非默认模型静默嵌入
    })

  async function upsertDoc(col: Collection, doc: KbDocRecord): Promise<void> {
    if (!doc.chunks.length) return
    await col.upsert({
      ids: doc.chunks.map((_, i) => `${doc.id}:${i}`), // id=docId:chunkIndex，天然幂等
      documents: doc.chunks,
      metadatas: doc.chunks.map((_, i) => ({ docId: doc.id, docName: doc.name, chunkIndex: i })),
      embeddings: await embedAll(doc.chunks),
    })
  }

  // 对账重建的并发闸：同轮多工具并发 search_kb 时只重建一次，都等同一个 Promise
  let rebuilding: Promise<Collection> | null = null

  /** 条数对账：一致→直接用；不平→删了整库重灌（语料变更期间 chroma 掉线/索引丢失都靠它自愈） */
  async function ensure(docs: KbDocRecord[]): Promise<Collection> {
    const col = await collection()
    const expected = docs.reduce((s, d) => s + d.chunks.length, 0)
    const current = await col.count()
    if (current === expected) return col
    if (!rebuilding) {
      console.log(`[pa] 向量索引对账不平（${current} → ${expected} chunks），整库重灌集合 ${collectionName}`)
      rebuilding = (async () => {
        await client.deleteCollection({ name: collectionName }).catch(() => {})
        const fresh = await collection()
        for (const doc of docs) await upsertDoc(fresh, doc)
        return fresh
      })().finally(() => {
        rebuilding = null
      })
    }
    return rebuilding
  }

  return {
    async search(query, topK, docs) {
      if (dead) return null
      try {
        const col = await ensure(docs)
        const [qv] = await embedAll([query])
        const res = await col.query({ queryEmbeddings: [qv], nResults: topK })
        const ids = res.ids?.[0] ?? []
        const dists = res.distances?.[0] ?? []
        const hits: VectorHit[] = []
        ids.forEach((id, i) => {
          const [docId, chunkIndex] = id.split(':')
          // cosine 距离 → 相似度（越大越好，与 BM25 分数同向；跨路量纲不同，顺序才是契约）
          hits.push({ docId, chunkIndex: Number(chunkIndex), similarity: 1 - (dists[i] ?? 0) })
        })
        fails = 0 // 成功即清零熔断计数
        return hits
      } catch (err) {
        onFail('search', err)
        return null
      }
    },

    async onAdded(doc) {
      if (dead) return
      try {
        await upsertDoc(await collection(), doc)
        fails = 0
      } catch (err) {
        onFail('onAdded', err)
      }
    },

    async onRemoved(docId) {
      if (dead) return
      try {
        await (await collection()).delete({ where: { docId } })
        fails = 0
      } catch (err) {
        onFail('onRemoved', err)
      }
    },
  }
}
