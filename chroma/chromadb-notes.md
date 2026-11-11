# ChromaDB 入门功课（TS 版）—— 给 personal-agent 知识库向量升级铺路

> 定位：phase3 练习文档。先讲知识点，再给动手练习清单；练完第 7 题，「向量通道到底值不值得接入」就有数据了。全程 TypeScript：Node 24 直接跑 `.ts`，练习写的东西就是将来接入的雏形。
> API 以 chromadb **3.5.0** 实测为准——3.x 与网上多数 1.x 教程有出入（客户端选项、嵌入函数机制都变过）。

## 0. 先回答「要不要 V2」：不要

向量数据库在你的架构里是**检索层的派生索引**，不是新的主存储。想清楚两件事：

1. **记忆（memories）压根没有检索动作**。看 `personal-agent/server/chat-service.ts` 的 `prepareContext()`：`memories.list()` 是**全量注入** system prompt（`memorySystemContent`），条目不多、每条很短，不需要检索——所以「记忆搬向量库」其实无事可做。
2. **笔记（kb.json）才有检索**，但 kb.json 仍然可以是事实源（chunk 全文 + 元数据 + 审计），Chroma 只是它的**可重建缓存**：索引坏了/丢了，从 kb.json 重灌一遍就回来。存储纪律（原子写、单文件、人可读）一点不动。

所以改造面 = `createKbStore` 内部：`add/remove` 时同步维护 Chroma 索引，`search()` 里加一路向量召回做 RRF 融合。**`KbStore` 接口、`chat-service.ts`、`search_kb` 工具、前端全都不动**。这不算 V2，是一个函数的内部升级——`rag.ts` 开头注释里你自己留的升级路径就是它。

## 1. 向量检索到底在干什么

- **embedding**：模型把一段文本压成一个定长向量（如 512 维浮点数组），训练目标就是「意思相近的文本，向量距离近」。
- **检索**：把查询也嵌成向量，在库里找距离最近的 k 条 → 语义召回。
- 和 BM25 的互补（这是整个升级的立足点，07 实验已经验证过两面）：

| 查询形态 | 例子 | 谁赢 | 为什么 |
|---|---|---|---|
| 改述式（问法 ≠ 原文措辞） | 问「需求评审聊了啥」↔ 笔记写「和产品对齐了新版需求」 | 向量 | 字面零重叠，语义近 |
| 实体/专名精确 | 「李露露」「柳泉小学」 | BM25 | 向量对专名是浆糊，字面精确匹配才是主场 |

结论：**双路召回 + 融合**，不是替换。

## 2. 运行形态与练习环境搭建

Chroma = 轻量向量数据库：向量存 SQLite，检索用 HNSW 近似最近邻图。三种形态里，TS 只能用服务模式：

| 形态 | 接入方式 | TS 能用吗 |
|---|---|---|
| 嵌入持久化（`PersistentClient`） | 进程内直接用，数据落目录 | ❌ Python 专属 |
| 内存（`EphemeralClient`） | 进程退出即消失（测试用） | ❌ Python 专属 |
| **服务模式（`chroma run` + HTTP）** | 独立进程，客户端走 HTTP | ✅ **JS 客户端唯一形态**，练习和将来接入都是它 |

服务模式的心智模型：**库在服务进程手里，脚本只是客户端**——脚本退出数据还在，重启服务数据也还在；并发写由服务端排队兜底。

```bash
# 一次性环境（chroma/ 目录下）
npm init -y
npm i chromadb            # JS 客户端
# 本地嵌入备选路线再装：npm i @huggingface/transformers

# 每次练习：两个终端
# 终端 A —— 起服务（数据落 ./chroma_data，别关）
chroma run --path ./chroma_data --port 8000
# 终端 B —— 跑脚本（Node 24 原生跑 TS，无需 ts-node）
node 01-hello.ts
```

```ts
import { ChromaClient } from 'chromadb'
// 3.x 写法：path 选项已弃用，用 host/port/ssl（host 默认 localhost、port 默认 8000）
const client = new ChromaClient({ host: 'localhost', port: 8000 })
```

## 3. 数据模型

| 关系库概念 | Chroma 对应 | 说明 |
|---|---|---|
| database | client（path） | 一个目录一个库 |
| table | collection | 检索的基本单位，同库可多个 |
| row | record | 四元组：`id` + `document`(原文) + `metadata`(结构化字段) + `embedding`(向量) |
| 索引 | HNSW 图 | 自动维护，不用你建 |
| `WHERE` 过滤 | `where` 参数 | 在向量检索**之前**先过滤元数据（预过滤） |

预计算路线（§5）下**所有写操作自带 `embeddings`**，建集合时显式 `embeddingFunction: null` 声明「本集合不挂嵌入函数」。不写这句，3.x 会给集合记一个 default EF：没装 `@chroma-core/default-embed` 就每次操作刷一条警告（无害但吵）；**装了反而危险**——哪次忘传 embeddings，它会拿英文 MiniLM 静默替你嵌（fail-loud 变 fail-silent）。不装 + null 声明才是预计算路线的正确姿势：忘传 embeddings 直接报错，响亮。

## 4. CRUD 全操作

```ts
import { ChromaClient } from 'chromadb'

const client = new ChromaClient({ path: 'http://localhost:8000' })

// 建集合（已存在则复用）。⚠️ 距离度量在这里定死，事后改不了，只能新建集合重灌
const col = await client.getOrCreateCollection({
  name: 'notes',
  metadata: { 'hnsw:space': 'cosine' },   // 默认是 l2！文本语义检索一般用 cosine
  embeddingFunction: null,                 // 显式「不挂 EF，嵌入一律自带」——见 §3
})

const docs = [
  '今天和产品对齐了新版需求，砍掉了导出功能',
  'HNSW 是一种近似最近邻索引，用跳表式的多层图做检索',
  '组会提到李露露负责新版运营位',
]
const metas = [{ src: '日报' }, { src: '技术笔记' }, { src: '组会' }]

// 增：ids 必须唯一，撞了会报错；要幂等就用 upsert。embeddings 用 §5 的 helper 算
await col.add({ ids: ['a1', 'a2', 'a3'], documents: docs, metadatas: metas, embeddings: await embed(docs) })

// 查（语义）：queryEmbeddings 传自己嵌好的查询向量
const q = await embed(['需求评审聊了啥'])
const res = await col.query({ queryEmbeddings: q, nResults: 3,
  include: ['documents', 'metadatas', 'distances'] })
// ⚠️ 返回的是嵌套数组：外层对应每个查询，内层才是命中——取 [0]；TS 类型如实标了可空，用 ?. 兜
const hitDocs = res.documents?.[0] ?? []
const hitDists = res.distances?.[0] ?? []
const hitMetas = res.metadatas?.[0] ?? []
hitDocs.forEach((doc, i) =>
  console.log(`${hitDists[i]?.toFixed(4)}  [${(hitMetas[i] as { src?: string })?.src}]  ${doc}`))

// 查（不带语义，纯取回）：get / peek / count
await col.get({ ids: ['a1'] })              // 按 id 取
await col.get({ where: { src: '组会' } })    // 按元数据过滤取
await col.peek({ limit: 2 })                 // 随便看两条
await col.count()                            // 条数

// 改：update 只改已存在的 id（不存在的静默跳过）；upsert = 有则改无则插（幂等脚本用它）
// ⚠️ 没挂 EF 的集合里，改文本 = 自己重嵌 + documents/embeddings 一起传
const next = '今天和产品对齐了新版需求（更新：导出功能保留）'
await col.update({ ids: ['a1'], documents: [next], embeddings: await embed([next]) })
await col.upsert({ ids: ['a1', 'a4'], documents: [next, '新笔记'], embeddings: await embed([next, '新笔记']) })

// 删
await col.delete({ ids: ['a4'] })            // 按 id
await col.delete({ where: { src: '组会' } })  // 按元数据批量删
await client.deleteCollection({ name: 'notes' })  // 整集合删（重灌用）
```

## 5. embedding 从哪来（最重要的决策）

Chroma 自己**不带**嵌入模型。JS 客户端的 EF（嵌入函数）生态演进多变且绑定包版本，**TS 里直接用预计算路线最稳**：自己调模型算向量，写操作传 `embeddings`、查询传 `queryEmbeddings`——嵌入时机、批量、缓存全在你手里，将来接进 personal-agent 也是同一条路。

### A1 方舟 API（主推：中文效果好、无本地下载、和将来接入同款路径）

```ts
// 个人工具函数：批量嵌入。key 复用 personal-agent 同款环境变量
async function embed(texts: string[], model = '<方舟控制台开通的 doubao-embedding 模型ID>'): Promise<number[][]> {
  const r = await fetch('https://ark.cn-beijing.volces.com/api/v3/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.ARK_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: texts }),   // OpenAI 兼容形状；⚠️ 方舟单批上限 10 条，超了 400
  })
  if (!r.ok) throw new Error(`嵌入失败 ${r.status}: ${await r.text()}`)
  const data = (await r.json()).data as { index: number; embedding: number[] }[]
  return data.sort((a, b) => a.index - b.index).map((d) => d.embedding)  // ⚠️ 按 index 回填——返回序不保证按入参序
}
```

### A2 bge 本地模型（离线免费备选；CPU 可跑，几百 chunk 秒级）

```ts
// npm i @huggingface/transformers —— ONNX 推理，首次跑要联网拉模型
// 国内网络拉不动 HuggingFace 时，跑脚本前设：HF_ENDPOINT=https://hf-mirror.com
import { pipeline } from '@huggingface/transformers'

let extractor: Awaited<ReturnType<typeof pipeline>> | null = null  // 模型加载慢，全局只加载一次
async function embedLocal(texts: string[]): Promise<number[][]> {
  extractor ??= await pipeline('feature-extraction', 'Xenova/bge-small-zh-v1.5')  // 中文小模型，512 维
  const out = await extractor(texts, { pooling: 'mean', normalize: true })        // 归一化后 cosine≈ip
  return out.tolist() as number[][]
}
```

**铁律：索引和查询必须同一个模型**。换模型 = 整库重嵌 + 新集合（同一 collection 换模型会维度不匹配直接报错）。模型名写进集合名（`notes_ark` / `notes_bge`），练习 2 正好用两个集合对比。

## 6. 距离与相似度：分数量纲是坑

| 度量 | `hnsw:space` | 值域 | 方向 |
|---|---|---|---|
| 平方欧氏（默认，⚠️不开根号） | `l2` | [0, +∞) | 越小越近 |
| 余弦距离 = 1 − 余弦相似度 | `cosine` | [0, 2] | 越小越近 |
| 内积 | `ip` | (−∞, +∞) | 越大越近（向量归一化后≈cosine） |

关键认知：**Chroma 回的是「距离」，越小越好；你的 `bm25Search` 回的是分，越大越好**。两路融合时方向相反、量纲不通——直接加权平均是经典错误。这正是用 RRF（只用名次不用分数）的原因，见 §8。

## 7. 元数据过滤 where

```ts
await col.query({ queryEmbeddings: q, where: { src: '技术笔记' } })                       // 等值
await col.query({ queryEmbeddings: q, where: { src: { $eq: '技术笔记' } } })
await col.query({ queryEmbeddings: q, where: { days: { $lt: 7 } } })                       // 范围
await col.query({ queryEmbeddings: q, where: {                                            // 组合
  $and: [{ src: { $eq: '技术笔记' } }, { days: { $lt: 7 } }] } })
await col.get({ whereDocument: { $contains: 'HNSW' } })          // 按原文包含过滤（非语义）
```

操作符：`$eq $ne $gt $gte $lt $lte $in $nin`，组合 `$and $or`。过滤是**预过滤**（先筛再检索），不占 topK 名额——对「在某某文档里搜」这类需求比取回后再筛干净得多。

## 8. 混合检索与 RRF（接入的目标形态）

**为什么**：§1 的互补表。**怎么做**：两路各自出 topN，按名次融合：

```
RRF 分(d) = Σ_各路  1 / (k + rank(d))     k 惯例取 60
```

```ts
function rrf(lists: string[][], k = 60, top = 10): string[] {
  // 多路召回融合。只用名次不用分数——BM25 越大越好、cosine 距离越小越好也不怕（方向/量纲免疫）
  const scores = new Map<string, number>()
  for (const list of lists) {
    list.forEach((key, rank) => scores.set(key, (scores.get(key) ?? 0) + 1 / (k + rank + 1)))
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, top).map(([id]) => id)
}

const bm25Lane = ['a2', 'a5', 'a1']   // bm25Search 的 topN（按分数降序）
const vecLane = ['a1', 'a9', 'a2']    // Chroma 的 topN（按距离升序）
console.log(rrf([bm25Lane, vecLane])) // → ['a1', 'a2', 'a5', 'a9', ...]
```

映射到 `createKbStore.search()` 的目标形态（本次练习不写，先想清楚）：

```
search(query, topK):
  bm25 路 = bm25Search(query, docs, topN)            # 现有代码，原样
  向量路 = Chroma.query(queryEmbeddings=嵌入(query))  # try/catch
       └ 挂了（服务没起/没网/索引缺失）→ 降级纯 BM25，打个日志，不炸
  return RRF 融合两路，取 topK
```

## 9. 接入 personal-agent 的形态（2026-11-11 已实施：vector-lane.ts + core/rag.ts + server/state.ts）

- **部署**：`chroma run` 常驻（`yarn chroma`）；服务端 `ChromaClient` 连 HTTP；嵌入复用 09-harness/llm.ts 的 `embedClient`（`LLM_EMBED_*` 环境变量，零新增配置）。
- **集合设计**：按嵌入模型命名（`kb_<model>`——换模型=换集合，维度天然隔离）；`id = "<docId>:<chunkIndex>"`（幂等，upsert 随便重跑）；`metadata = {docId, docName, chunkIndex}`；`hnsw:space: cosine`；`embeddingFunction: null`（预计算路线）。
- **同步**：add/remove 落盘后 fire-and-forget 增量同步；search 时条数对账，不平自动整库重灌（并发闸防同轮多查询重复重建）——kb.json 是唯一事实源，索引是可重建缓存，不需要管理脚本。
- **融合**：向量为主、BM25 补位（union 追加不抢位）——§12 实测等权 RRF 被弱路拖累，07 预留的 RRF 路线作废。
- **降级**：通道任何异常自吞降级纯 BM25；连续失败 3 次进程内熔断（重启复活）；`PA_KB_VECTOR=0` 整体关（旧探针/E2E 想回纯 BM25 基线时用）。

## 10. 动手练习清单（递进，建议按序）

每题独立可跑（`node 练习N.ts`），观察点比「跑通」更重要。前提：终端 A 的 `chroma run` 开着，`embed()` helper 就绪。

**练习 1｜起库与第一批语义召回**：`ChromaClient` + cosine 集合 + §4 的三条中文（嵌入用 A1 或 A2）+ 查「需求评审聊了啥」。
观察点：三句笔记字面上都没有「评审」，看向量能不能召回「对齐了新版需求」那条——这就是 BM25 给不了的东西。顺带体感服务模式生命周期：脚本退出后再跑 `count()`，数据还在。

**练习 2｜两个中文嵌入模型对比**：同批数据建两个集合（`notes_ark` / `notes_bge`，铁律：模型不同集合必须分开），同样的查询各跑一遍。
观察点：`distances` 的排序与间隔差异；改述查询和实体查询（「李露露」）各自在两个模型下的表现；顺带对比 API 延迟 vs 本地 CPU 推理耗时——这是将来选型的两个维度。

**练习 3｜ids 幂等**：把练习 1 的脚本连跑两遍——第二遍 `add` 报错；改成 `upsert` 再跑，`count()` 不变。
观察点：「索引脚本可反复执行」靠 upsert，这决定了将来 rebuild 脚本的写法。

**练习 4｜元数据过滤**：加几条不同 `src`/`days` 的数据，跑等值、范围、`$and` 组合三个 where 查询。
观察点：过滤先行——命中的都在筛选范围内，且 topK 名额不被范围外的占。

**练习 5｜l2 vs cosine**：同数据建两个集合（一个默认 l2，一个 cosine），同查询对比 `distances`。
观察点：l2 的数值尺度完全不同（平方距离，受向量模长影响）；体感「为什么文本检索统一用 cosine」。

**练习 6｜完整 CRUD 闭环**：update 改一条（自己重嵌 + documents/embeddings 一起传）→ delete 按 id 和按 where 各删一次 → count 验证 → `deleteCollection` 收尾清场。
观察点：update 只动已存在 id；删除是物理删，没有软删。

**练习 7｜真实验：你的笔记语料三路对比**（接不接入的决策依据）：
1. 读 `personal-agent/data/rag/kb.json`，全部 chunk 灌进 Chroma（`id = docId:chunkIndex`）；
2. 编 10 个查询：一半改述式（问法故意不挨笔记原词），一半实体式（人名/项目名/专名）；
3. 三路对比：纯 BM25 vs 纯向量 vs RRF 融合——**TS 同语言的独家优势：直接 `import { bm25Search } from '../personal-agent/core/rag.ts'`，和线上检索一字不差，不用跨语言复刻**；
4. 出一张命中率表：每查询 × 每路，期望命中的块排第几（或没进 top3）。
观察点：改述组向量是否显著赢、实体组 BM25 是否守住、RRF 是否两头都不最差。**表好看 → 按 §9 接入；表不好看 → 省下整个改造，练习目的也已达成。**

## 11. 踩坑速查表

| 坑 | 现象 | 处置 |
|---|---|---|
| 删除集合/重建集合 | bin 目录留在磁盘攒尸体（删除只清账本不清文件，无自动 GC）；Windows 下运行中的服务还握着已删段句柄，直接删 EPERM | `node chroma/cleanup-index.ts` 干跑看清单 → 停 chroma → `--clean` → 重启 |
| JS 客户端只有 HTTP 模式 | 找 `PersistentClient` 找不到 | TS 一律 `chroma run` + `ChromaClient`，练习先开终端 A |
| `new ChromaClient({ path })` | deprecation 警告 | 3.x 用 `{ host, port, ssl }` |
| 建集合没写 `embeddingFunction: null` | 每次操作刷「install @chroma-core/default-embed」警告 | null 显式声明无 EF；**别靠装 default-embed 消音**——忘传 embeddings 会变英文模型静默嵌入；建过带 default 的旧集合要删了重建 |
| 写操作不带 embeddings | 没挂 EF 的集合直接报错 | 路线 A 本来就自己嵌：add/update/upsert 全带 `embeddings` |
| 默认距离是 l2 | 分数不是直觉的「相似度」 | 建 collection 时显式 `metadata: { 'hnsw:space': 'cosine' }` |
| 同一集合换嵌入模型 | 维度不匹配直接报错 | 每个模型一个新集合（名字带模型后缀），换模型=重灌 |
| `add` 撞已有 id | 报错 | 幂等脚本一律 `upsert` |
| query 返回嵌套数组 | 少取 `[0]` 把整包当命中 | 外层=查询数，内层=命中；TS 类型可空，`?.[0]` 兜底 |
| 距离 vs 分数方向相反 | 和 BM25 融合直接加权出乱序 | 用 RRF，只看名次 |
| 方舟 embeddings 返回序 | 以为是入参序 | 响应带 `index`，按它回填 |
| 方舟 embedding 单批上限 10 条 | `400 ... input limit exceeded: max 10` | 分批 `slice(i, i + 10)`，见 compare.ts |
| 本地模型拉不动 | transformers.js 首次下载卡住 | `HF_ENDPOINT=https://hf-mirror.com`，或直接走 A1 方舟 |
| 单批 add 有上限（几千，版本相关） | 大批量报错 | 分批，每批 ≤1000 |
| 相对 path 起服务 | 换目录跑「库不见了」 | `--path` 用绝对路径或固定锚点；嵌入模式（Python）与服务模式别共用同目录 |

## 12. 练习 7 实验结果（2026-11-11 · 69 chunk · doubao-embedding-vision · compare.ts + bare.ts）

| 路线 | 改述组(5)<br>top3 命中 · 均名次 | 实体组(5)<br>top3 命中 · 均名次 | 裸实体组(5)<br>top3 命中 |
|---|---|---|---|
| BM25（线上同款） | 2/5 · 4.2 | 4/5 · 2.2 | 5/5 |
| 纯向量 | **5/5 · 1.2** | **5/5 · 1.4** | **5/5**（裸 commit 哈希也第 1） |
| 等权 RRF | 4/5 · 2.4 | 4/5 · 1.8 | — |

负例校验：语料中不存在的「李露露」两路均正确落空（评分器没瞎给分）。

**三条结论：**

1. **07 先验未复现**——「实体=向量盲区、必须配 BM25」在强嵌入模型 + 69 chunk 小语料下不成立（小语料放大向量优势：信号再糊也只需赢 68 个对手）。反倒是 BM25 有真实盲区：改述组 2/5 落空，这才是向量通道要补的洞（PITFALLS #63）。
2. **等权 RRF 被弱路拖累**——比纯向量差：BM25 的噪声名次把向量的第 1 拖到 2~5 名。融合不是免费增益，一路独强时弱路只该补位不该抢位。
3. **接入策略照数据走**：向量为主、BM25 补位（union 追加或加权 RRF，弱路不许拉低强路排名）；向量路故障（没网/服务没起/索引缺失）降级纯 BM25——离线、零成本、确定性（同输入同结果，可回归探针）是 BM25 不可替代的面。

**边界（别过度外推）**：10+5 个查询、单次运行、查询是知道答案的人编的（存在设计偏置）；语料涨到几百上千 chunk 后两路互补性可能重现——届时重跑 `node chroma/compare.ts` 再看（索引每次自动重建）。
