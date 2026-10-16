/*
模块 07 战果：BM25 + 混合检索（已完成，随 08 的累积式 agent 继续服役，本文件无改动）

立项理由（07 实测探针）：search('媳妇叫什么') top1/top2 差 0.001（0.408 vs 0.407），
search('李露露') 把 birth-years 排在 family-size 前面——专有名词没有语义可供嵌入，
纯向量对实体查询的排序是浆糊。字面精确匹配恰好是 BM25 的主场，两路互补。

模块 08 起它就是 search_memory 的底层（memory.ts 已接线 hybridSearch）：
① tokenize     中文分词（bigram + 英数连串）
② bm25Search   Okapi BM25 打分（k1=1.5, b=0.75，零分项源头过滤）
③ rrfFuse      两路排名融合（1/(60+rank)，量纲免疫）
④ hybridSearch 混合入口（向量 + BM25 各取 top10 → RRF → 切 k）
验收探针：node 08-planner/bm25.ts（结果已录 07 的 TUTORIAL §2）

三个设计决策（想清楚再动手，比代码本身值钱）：
- 语料：每条记忆一个文档 = name + 摘要 + 正文。向量线只嵌 30 字摘要（钩子设计，别动它——
  单变量实验），但实体名（李露露/柳泉小学）大多躺在正文里。BM25 是本地计算、零 API 成本，
  用最全的文本；两条通道候选集相同，只是各自用最擅长的表示
- 融合用 RRF 不用分数加权：cosine 落在 0.4~0.5 的窄带、BM25 无上界（0~20+），量纲对不齐；
  min-max 归一在 15 个文档的小集合上极不稳定。RRF 只用排名，天然免量纲
- BM25 零分项必须过滤掉再融合：'媳妇叫什么' 在字面层可能一个词都匹配不上（记忆里写的是
  「妻子」），全零通道若不过滤，任意顺序的垃圾排名照样给 RRF 添 1/(60+rank) 的分——
  过滤后该查询自然退化回纯向量排序，语义主场不受干扰
*/
import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseMemoryIndex, search } from './vector_store.ts'

// ---------- ① 分词 ----------
// 中文 BM25 的命门是分词。不引依赖的标准解：CJK 二元组（bigram）+ 英数连串小写：
//   '妻子李露露用999皮炎平' -> ['妻子','子李','李露','露露','露用','999','皮炎','炎平']
// 查询和文档用同一个 tokenizer，'李露露' -> ['李露','露露'] 才能和文档命中
// 提示：/[一-鿿]+|[a-z0-9]+/gi 先切出中文串和英数串；中文串滑窗取相邻两字，
// 单字的串（串长为 1）保留本身；英数串 toLowerCase 整体当一个词
export function tokenize(text: string): string[] {
	const arr: string[] = []
	const texts = [...text.matchAll(/[一-鿿]+|[a-z0-9]+/gi)].map((item) => item[0])
	// console.log(texts)
	for (let i = 0, len = texts.length; i < len; i++) {
		const a = texts[i]
		if (/^[a-z0-9]+$/i.test(a)) {
			// 英文 数字
			arr.push(a.toLowerCase())
		} else {
			// 多个/单个汉字
			if (a.length === 1) {
				arr.push(a)
				continue
			}
			for (let j = 0, aLen = a.length; j < aLen - 1; j++) {
				arr.push(a.substring(j, j + 2))
			}
		}
	}
	return arr
}

// console.log(tokenize('我是赵德升，简称zds,你是who,I am 12 岁'))
// console.log(tokenize('妻子李露露用999皮炎平'))
// console.log(tokenize('李露露'))

// ---------- ② BM25 ----------
export interface Doc {
	name: string
	text: string
}

// 语料加载：索引拿 {name, abstract}，再逐个读 memories/<name>.md 拼上正文。
// 读不到正文（文件缺）就用 name + abstract 兜底，别让一条脏数据炸整个索引
export async function loadDocs(): Promise<Doc[]> {
	const memoryIndex = await parseMemoryIndex()
	const promises = [...memoryIndex.values()].map(async ({ name, abstract }) => {
		const memoryPath = path.resolve(import.meta.dirname, 'memories', `${name}.md`)
		let content: string
		try {
			content = await fs.readFile(memoryPath, 'utf-8')
		} catch {
			content = `${name} ${abstract}`
		}
		return { name, text: content }
	})

	const res = await Promise.all(promises)
	return res
}

// console.log(await loadDocs())

// Okapi BM25：
//   score(q, d) = Σ_i IDF(qi) · tf(qi,d)·(k1+1) / ( tf(qi,d) + k1·(1 - b + b·|d|/avgdl) )
//   IDF(t) = ln(1 + (N - df + 0.5) / (df + 0.5))    —— +1 保证非负（经典式在 df > N/2 时会变负）
//   k1 = 1.5 词频饱和速度，b = 0.75 长度归一强度（Elasticsearch 同款默认）
// 坑预告：空库/全空文档 avgdl = 0 除零 → 提前 return []；query 词不在语料里时
// df = 0、tf = 0，该项贡献自然是 0，不用特判
export function bm25Search(query: string, docs: Doc[], k = 10): { name: string; score: number }[] {
	if (!docs.length) return []
	// ---- 预计算（每次调用重算，15 条记忆无所谓；生产环境的倒排索引就是把这步做成增量结构）----
	const docTokens = docs.map((d) => tokenize(d.text)) // 每篇的 token 序列
	/** 文档数 */
	const N = docs.length
	/** 平均文档token长度（按 token 数） average document length */
	const avgdl = docTokens.reduce((sum, t) => sum + t.length, 0) / N // 平均文档长度（按 token 数）
	if (!avgdl) return [] // 全空语料的除零守卫

	// df：词出现在几篇文档里（注意是"几篇"不是"几次"——所以先 Set 去重再计数）document frequency
	const df = new Map<string, number>()
	for (const tokens of docTokens) {
		for (const t of new Set(tokens)) {
			df.set(t, (df.get(t) ?? 0) + 1)
		}
	}

	const k1 = 1.5 // 词频饱和速度：命中次数的得分上界 ≈ (k1+1) 倍
	const b = 0.75 // 长度归一强度：0 = 完全不管长短，1 = 完全按长度摊薄

	// ---- 逐文档打分 ----
	const scored = docs.map((doc, i) => {
		// tf 表：本篇里每个词出现几次 token frequency
		const tf = new Map<string, number>()
		for (const t of docTokens[i]) {
			tf.set(t, (tf.get(t) ?? 0) + 1)
		}
		const dl = docTokens[i].length

		let score = 0
		// 查询侧的重复词只算一次（标准式还有个查询词频项 k3，实践里都省略）
		for (const q of new Set(tokenize(query))) {
			const f = tf.get(q)
			if (!f) continue // 本篇没这个词 → 该项贡献 0；同时保证下面 df.get 必然取得到
			const dfv = df.get(q)!
			// IDF（词的稀有度）：'李露' 只在 3 篇出现 → 分高；'用户' 几乎篇篇有 → 趋近 0。
			// ln(1 + x) 的 +1 保证结果非负（经典 Robertson 式在 df > N/2 时会算出负分）
			const idf = Math.log(1 + (N - dfv + 0.5) / (dfv + 0.5))
			// tf 饱和项：分子分母都随 f 线性涨 → 边际递减，命中 10 次的价值远小于 1 次的 10 倍，
			// 防止一篇把同一个词刷屏的文档霸榜
			// 长度归一项：1 - b + b·dl/avgdl —— 同样命中 1 次，短文档更"密"更该排前
			score += (idf * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * dl) / avgdl))
		}
		return { name: doc.name, score }
	})

	// 零分过滤在源头做：一个词都没命中的文档不进排名。'媳妇叫什么' 这种字面全不沾的查询
	// 在这一步整通道出局，RRF 处只剩向量通道的发言权——语义主场不被垃圾排名污染
	return scored
		.filter((s) => s.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, k)
}

// ---------- ③ RRF 融合 ----------
//   rrf(d) = Σ_通道 1 / (60 + rank_通道(d))    rank 从 1 起；不在某通道 top 里的文档该通道贡献 0
//   k=60 是业界经验值（Elasticsearch / LangChain EnsembleRetriever 同款），不敏感
export function rrfFuse(rankings: { name: string }[][], k: number): { name: string; score: number }[] {
	const K = 60
	const scores = new Map<string, number>()
	for (const ranking of rankings) {
		ranking.forEach(({ name }, i) => {
			// rank 从 1 起（i 是 0 基）。第 1 名贡献 1/61 ≈ 0.0164，第 10 名 1/70 ≈ 0.0143——
			// 排名间的分差被刻意压得很平：单通道霸榜掀不起大浪，两路共识说了算
			scores.set(name, (scores.get(name) ?? 0) + 1 / (K + i + 1))
		})
	}
	// 两路都排第 1 → 2/61，恰好是单通道第 1 名的两倍：共识文档天然冒头。
	// 只用排名不用分值 → cosine 窄带和 BM25 无上界的量纲差异被彻底绕开，也就无需调权重
	return [...scores]
		.map(([name, score]) => ({ name, score }))
		.sort((a, b) => b.score - a.score)
		.slice(0, k)
}

// ---------- ④ 混合入口 ----------
// 通道深度取 10（每路多召回一些，融合后再切 k）——只在最后一刀收紧，两路都能进人
export async function hybridSearch(query: string, k = 3): Promise<{ name: string; score: number; abstract: string }[]> {
	const vecRanking = await search(query, 10) // 向量通道：现有 search 原样复用
	const docs = await loadDocs()
	const bm25Ranking = bm25Search(query, docs, 10)
	// 观测给人看，不进模型上下文（模块 06 的老规矩）——两路排名并排打出来，融合有没有
	// 「救回实体查询、不伤语义查询」一眼可判
	console.log(`[hybrid] 向量: ${vecRanking.map((r) => `${r.name}(${r.score.toFixed(3)})`).join(' ')}`)
	console.log(`[hybrid] BM25: ${bm25Ranking.map((r) => `${r.name}(${r.score.toFixed(2)})`).join(' ')}`)
	// rrfFuse 融合两路 → 取前 k → 从 parseMemoryIndex() 拼上摘要，
	// 返回 {name, score(=rrf分), abstract}[]
	const fused = rrfFuse([vecRanking, bm25Ranking], k)
	const memoryIndex = await parseMemoryIndex()
	return fused.map(({ name, score}) => {
		const abstract = memoryIndex.get(name)?.abstract || `未找到name为${name}对应的摘要` 
		return {
			name, 
			score,
			abstract
		}
	})
}

// ---------- ⑥ 验收探针 ----------
// 先跑基线（纯向量，TUTORIAL §2 已贴）再跑混合，并排对比——召回提升要数字说话。
// 每条记 top-3 名单 + gold 是否在内，填 TUTORIAL §2 的表：
//   实体型（BM25 主场）：'李露露' / '柳泉小学' / '999皮炎平治什么的'
//   语义型（向量主场，验证没被拉坏）：'媳妇叫什么' / '我睡眠怎么样' / '我小时候在河边干嘛'
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
	const PROBES = ['李露露', '柳泉小学', '999皮炎平治什么的', '媳妇叫什么', '我睡眠怎么样', '我小时候在河边干嘛']
	for (const q of PROBES) {
		console.log(`\n=== ${q} ===`)
		const fused = await hybridSearch(q, 3)
		fused.forEach((r, i) => console.log(`  ${i + 1}. ${r.name} (rrf ${r.score.toFixed(3)}) ${r.abstract}`))
	}
}
