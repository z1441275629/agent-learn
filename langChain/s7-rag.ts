// S7 RAG 快站（OUTLINE §3 S7——你比多数面试官熟，主要是走官方路线补框架视角）
// 验收：LangSmith 里有一次完整 eval 实验（eval 模式）
// 语料：langChain/ 自己的学习文档——问题答案可回查，eval 标签天然可信
// 跑法：
//   node langChain/s7-rag.ts ingest              # 官方路线建索引：load → splitter → embeddings → Chroma
//   node langChain/s7-rag.ts ask "查询词"        # retriever 抽象检索：向量 vs BM25 两路对照
//   node langChain/s7-rag.ts eval                # LangSmith dataset + evaluate（验收件）
// 坑（实测）：Chroma.fromExistingCollection 是 getOrCreate 语义——集合不存在时【静默建空集合】，
//   查询静默返回空（表象「向量没结果」，锅在创建语义）。先 ingest 再 ask；怀疑时直接查 col.count()
// 前置：① chroma server 起着（pa 同款，PA_CHROMA_URL 缺省 http://localhost:8000）
//       ② .env 有 LLM_EMBED_BASE_URL / LLM_EMBED_MODEL（pa 同一套，缺 EMBED_API_KEY 回落 LLM_API_KEY）
//
// 官方路线 vs pa 手写（对照进面试）：
// - splitter：RecursiveCharacterTextSplitter（递归分隔符）vs pa chunkText（按行打包 500 字——个人笔记
//   按行组织有天然段落边界，pa 的切块对语料更贴身；官方件是通用兜底）
// - 向量库：Chroma.fromDocuments / asRetriever({k}) 包装 vs pa 手写 upsert/query + 对账自愈
//   （kb.json 唯一事实源，索引是可重建缓存——官方包装没有这层，retriever 抽象让混合策略可替换是真的）
// - BM25：BM25Retriever 默认空白分词（CJK 弱）vs pa 自写 CJK 二元组——检索质量的地基在分词，
//   这正是 #63 的隐含实验条件之一（PITFALLS #63：先验自带实验条件，换语料换模型先复验）
// - 面试主线不变：69 chunk 三路实测——向量为主 BM25 补位、等权 RRF 被弱路拖累；框架视角收尾一句：
//   retriever 抽象让「向量/BM25/混合」成为可替换策略位，实测选型（#63）在策略位里完成
import 'dotenv/config'
import * as fs from 'node:fs'
import { Document } from '@langchain/core/documents'
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters'
import { OpenAIEmbeddings } from '@langchain/openai'
import { Chroma } from '@langchain/community/vectorstores/chroma'
import { BM25Retriever } from '@langchain/community/retrievers/bm25'
import { Client } from 'langsmith'
import { evaluate } from 'langsmith/evaluation'

const env = process.env
const CHROMA_URL = env.PA_CHROMA_URL || 'http://localhost:8000'
const COLLECTION = 's7-corpus'

// pa 同款嵌入端点（方舟兼容 /embeddings；单批上限 10——vector-lane.ts 实测踩过 400）
const embeddings = new OpenAIEmbeddings({
  model: env.LLM_EMBED_MODEL!,
  apiKey: env.LLM_EMBED_API_KEY || env.LLM_API_KEY!,
  configuration: { baseURL: env.LLM_EMBED_BASE_URL! },
  batchSize: 10,
})

// 语料：三份学习文档（切块各带 source 元数据——eval 的命中标签就是它）
const CORPUS = [
  { file: 'langChain/OUTLINE.md', source: 'OUTLINE.md' },
  { file: 'PITFALLS.md', source: 'PITFALLS.md' },
  { file: 'langChain/pa-langgraph-map.md', source: 'pa-langgraph-map.md' },
]
const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 500, chunkOverlap: 50 })

async function loadDocs() {
  const docs: Document[] = []
  for (const c of CORPUS) {
    const text = fs.readFileSync(c.file, 'utf8')
    const parts = await splitter.createDocuments([text], [{ source: c.source }])
    docs.push(...parts)
    console.log(`  [load] ${c.source}: ${parts.length} chunks`)
  }
  return docs
}

const mode = process.argv[2] ?? 'ask'

// ═══ ingest：官方路线建索引 ═══
if (mode === 'ingest') {
  console.log(`═══ S7 ingest：splitter → embeddings → Chroma（${COLLECTION} @ ${CHROMA_URL}）═══`)
  const docs = await loadDocs()
  // fromDocuments 一步完成建集合+批量嵌入+入库（pa 手写里对应的 upsert + 按模型分集合）
  const store = await Chroma.fromDocuments(docs, embeddings, { collectionName: COLLECTION, url: CHROMA_URL })
  console.log(`  ✓ 入库 ${docs.length} chunks → collection "${COLLECTION}"`)
  console.log('  下一步：node langChain/s7-rag.ts ask "S4 的验收标准是什么"')
}

// ═══ ask：retriever 抽象——向量 vs BM25 两路对照 ═══
else if (mode === 'ask') {
  const q = process.argv[3] ?? 'checkpointer 快照和业务层账本有什么区别？'
  console.log(`═══ S7 ask：向量（Chroma）vs BM25 两路对照 ═══\n问：${q}`)
  // 坑（#68 方言家族）：Python 叫 from_existing_index，JS 是 fromExistingCollection
  const store = await Chroma.fromExistingCollection(embeddings, { collectionName: COLLECTION, url: CHROMA_URL })
  const vecHits = await store.asRetriever({ k: 3 }).invoke(q)
  console.log('\n── 向量 top3 ──')
  vecHits.forEach((h, i) => console.log(`  ${i + 1}. [${h.metadata.source}] ${h.pageContent.replace(/\n/g, ' ').slice(0, 60)}`))

  // BM25 对照：注意默认分词对 CJK 弱（空白切）——pa 的 CJK 二元组才是主场分词（#63 实验条件之一）
  const docs = await loadDocs() // BM25 无索引依赖，内存建（官方件即用性 vs pa 常驻索引）
  const bm25 = BM25Retriever.fromDocuments(docs, { k: 3 })
  const bmHits = await bm25.invoke(q)
  console.log('\n── BM25 top3（默认空白分词，CJK 弱——对照 pa 二元组的动机）──')
  bmHits.forEach((h, i) => console.log(`  ${i + 1}. [${h.metadata.source}] ${h.pageContent.replace(/\n/g, ' ').slice(0, 60)}`))
}

// ═══ eval：LangSmith dataset + evaluate（验收件）═══
else if (mode === 'eval') {
  console.log('═══ S7 eval：LangSmith 实验（验收：UI 里可见完整实验）═══')
  const client = new Client()
  const DS = 's7-rag-qa'
  // 小 dataset：8 问，实体/字面 与 改述 各半（#63 的两类查询形态——eval 覆盖两态才有说服力）
  const examples = [
    { question: 'S4 站的验收标准是什么？', expected_source: 'OUTLINE.md' },
    { question: 'checkpointer 快照和业务层账本有什么区别？', expected_source: 'OUTLINE.md' },
    { question: 'Send 并行分发和条件边有什么区别？', expected_source: 'OUTLINE.md' },
    { question: '为什么等权 RRF 在我的语料上被弃用？', expected_source: 'PITFALLS.md' },
    { question: '判定节点温度不锁会发生什么？', expected_source: 'PITFALLS.md' },
    { question: '原地改 reducer 会不会污染历史快照？', expected_source: 'PITFALLS.md' },
    { question: 'mermaid 子图块内为什么不能提外面的节点？', expected_source: 'pa-langgraph-map.md' },
    { question: 'composite 审校打回怎么画回边？', expected_source: 'pa-langgraph-map.md' },
  ]
  if (!(await client.hasDataset({ datasetName: DS }))) {
    const ds = await client.createDataset(DS, { description: 'S7 检索 hit@3 评估——语料为 langChain 学习文档' })
    // 弃用链两跳（d.ts 实录）：outputs 参数 → referenceOutputs；props 对象重载 → uploads 数组。
    // 终态：createExamples(ExampleCreate[])，每例自带 dataset_id + reference_outputs（snake_case）
    await client.createExamples(
      examples.map((e) => ({
        dataset_id: ds.id,
        inputs: { question: e.question },
        reference_outputs: { expected_source: e.expected_source },
      })),
    )
    console.log(`  [dataset] "${DS}" 已建（${examples.length} 例）`)
  } else console.log(`  [dataset] "${DS}" 已存在，复用`)

  const store = await Chroma.fromExistingCollection(embeddings, { collectionName: COLLECTION, url: CHROMA_URL }) // JS 方法名（#68）：非 Python 的 from_existing_index
  const retriever = store.asRetriever({ k: 3 })

  // 检索质量评估器：hit@3（期望文档进没进 top3）+ MRR（进了排第几）
  // 坑（报错实锤）：langsmith 0.9 的 evaluators 要【裸函数】(args)=>{key,score}——
  // 传 {key, evaluate: fn} 对象会走废弃 RunEvaluator 分支（找 .evaluateRun 方法）报
  // "evaluator is not a function"。args.outputs=target 返回值，args.referenceOutputs=example.outputs
  const results = await evaluate(
    async (input: any) => {
      const hits = await retriever.invoke(input.question)
      return { sources: hits.map((h) => String(h.metadata.source)), top: hits[0]?.pageContent.slice(0, 80) ?? '' }
    },
    {
      data: DS,
      client,
      experimentPrefix: 's7-rag-retriever',
      maxConcurrency: 4,
      evaluators: [
        async (args: any) => {
          const sources: string[] = args.outputs?.sources ?? []
          const expected = String(args.referenceOutputs?.expected_source ?? '')
          return { key: 'hit@3', score: sources.includes(expected) ? 1 : 0 }
        },
        async (args: any) => {
          const sources: string[] = args.outputs?.sources ?? []
          const expected = String(args.referenceOutputs?.expected_source ?? '')
          const idx = sources.indexOf(expected)
          return { key: 'mrr', score: idx === -1 ? 0 : 1 / (idx + 1) }
        },
      ],
    },
  )
  const rows = (results as any)?.results ?? []
  console.log(`\n[完成] ${rows.length} 行评估——完整结果（每问的 hit@3 / MRR feedback）看 LangSmith UI → Datasets → ${DS} → Experiments`)
} else console.log(`未知模式：${mode}（ingest | ask | eval）`)
