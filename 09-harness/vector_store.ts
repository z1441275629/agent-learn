/*
模块 07 战果，随 08 的累积式 agent 继续服役（本文件无改动）：
- 检索线三件套：embed（embedding-3，走 paas 按量端点）+ cosine + search（摘要向量 top-k）
- 治理线：findMostSimilarByContent（正文向量查重）+ backfillContentVectors（旧数据补正文向量）
- 持久化：vectors.json = {name, vector, contentVector?}[]
注意：路径全是 import.meta.dirname 相对——08 的记忆库是 07 落成时 fork 的独立副本（16 条），
07 是冻结快照（实验归档），08 是活体，两边各自演化别混写
*/

import fs from 'node:fs/promises'
import path from 'node:path'
import { embedClient, EMBED_MODEL } from './llm.ts'
import type { Chunk, MemoryIndexItem, VectorItem } from './type.ts'

export async function embed(texts: string[]) {
	const response = await embedClient.embeddings.create({
		model: EMBED_MODEL,
		input: texts,
	})
	return response.data.map((item) => item.embedding)
}

// cosine：手写余弦相似度 = 点积 / (模A * 模B)
//       思考：embedding 已经归一化的话，余弦相似度退化成什么？（点积）
// 思考答案  ???
export function cosine(a: number[], b: number[]): number {
	const dotProduct = a.reduce((sum, val, i) => sum + val * b[i], 0)
	const magnitudeA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0))
	const magnitudeB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0))
	return dotProduct / (magnitudeA * magnitudeB)
}

// query 向量 vs 所有记忆向量，返回 top-k 的 {name, score, 摘要}
export async function search(query: string, k = 3) {
	// 获取查询字符串向量
	const queryEmbedding = await embed([query])
	const queryVector = queryEmbedding[0]

	// 获取记忆中的向量值，读取向量数据库的数据——我这是vectors.json
	// 整读 + JSON.parse。catch 两种情况都归"空库"：文件还不存在（从没写过向量）/ JSON 坏了
	// ——空数组时 search 自然返回空结果，不该崩（和 getSystemPrompt / updateIndex 同一个模式）
	const vectors: VectorItem[] = await parseVectorsFromFile()

	// 对向量进行cosine打分
	const scores = vectors.map(({ name, vector }) => ({
		name,
		score: cosine(queryVector, vector),
	}))
	const topK = scores.sort((a, b) => b.score - a.score).slice(0, k)

	// 把相应的摘要加到topK数据中
	let res: (VectorItem & { abstract: string })[]

	const memoryIndexMap = await parseMemoryIndex()
	return topK.map((item) => {
		return { ...item, abstract: memoryIndexMap.get(item.name)?.abstract || `记忆 ${item.name} 的索引未找到` }
	})
}

export async function historyMemoryToVector() {
	const vectors: VectorItem[] = await parseVectorsFromFile()
	const memoryIndexMap = await parseMemoryIndex()
	const missList = []
	for (let [name, { abstract }] of memoryIndexMap.entries()) {
		if (!vectors.some((item) => item.name === name)) {
			missList.push({ name, abstract })
		}
	}
	if (!missList.length) {
		console.log('\n记忆索引和向量数据完全对应，没有缺失的索引向量\n')
		return
	}
	console.log(`\n有${missList.length}条数据缺少向量，现在补上\n`)
	const texts = missList.map((item) => item.abstract)
	const allVectors = await embed(texts)
	const list = missList.map((item, index) => ({ name: item.name, vector: allVectors[index] }))
	await batchSaveVectors(list)
	console.log('\n缺失向量补充完成，数据清洗完成\n')
}

// 批量存储记忆向量
export async function batchSaveVectors(list: VectorItem[]) {
	const vectors = await parseVectorsFromFile()
	const vectorMap = arrayToMap(vectors, 'name')
	const fs = await import('fs/promises')
	const path = await import('node:path')
	// 数组转成map，然后set的时候可以修改旧值，最后再将map.values转成数组
	list.forEach(({ name, vector }) => {
		vectorMap.set(name, { name, vector })
	})
	const newVectors = [...vectorMap.values()]
	const vectorPath = path.resolve(import.meta.dirname, 'vectors.json')
	await fs.writeFile(vectorPath, JSON.stringify(newVectors))
	console.log(`\n所有的向量名称:${[...vectorMap.keys()]}\n`)
}

// ---------- 治理线（查重/合并） ----------
// 和 search() 的分工：search 查摘要向量服务检索；这里查正文向量服务治理——
// "语义重复"的判断依据是事实内容，不是 30 字摘要（摘要太薄，区分度不够）
export async function findMostSimilarByContent(content: string): Promise<{ name: string; score: number } | undefined> {
	const vectors = await parseVectorsFromFile()
	const candidates = vectors.filter((item): item is VectorItem & { contentVector: number[] } => !!item.contentVector)
	if (!candidates.length) return undefined
	const [queryVector] = await embed([content])
	const best = candidates
		.map((item) => ({ name: item.name, score: cosine(queryVector, item.contentVector) }))
		.sort((a, b) => b.score - a.score)[0]
	return best
}

// 一次性清洗：给只有摘要向量的旧数据补正文向量（幂等，缺才补）
export async function backfillContentVectors(): Promise<void> {
	const vectors = await parseVectorsFromFile()
	const missing = vectors.filter((item) => !item.contentVector)
	if (!missing.length) {
		console.log('contentVector 无缺失，不用补')
		return
	}
	const entries = await Promise.all(
		missing.map(async (item) => {
			try {
				const content = await fs.readFile(path.resolve(import.meta.dirname, 'memories', `${item.name}.md`), 'utf8')
				return { item, content }
			} catch {
				console.log(`跳过 ${item.name}：正文文件缺失，补不了`)
				return undefined
			}
		}),
	)
	const ok = entries.filter((e): e is { item: VectorItem; content: string } => !!e)
	if (!ok.length) return
	const vecs = await embed(ok.map((e) => e.content))
	ok.forEach((e, i) => (e.item.contentVector = vecs[i]))
	await fs.writeFile(path.resolve(import.meta.dirname, 'vectors.json'), JSON.stringify(vectors))
	console.log(`已补 ${ok.length} 条 contentVector`)
}

// 把索引文件解析成map，方便查找值 map<name, {time, name, abstract}>
export async function parseMemoryIndex(): Promise<Map<string, MemoryIndexItem>> {
	const memoryIndexMap = new Map<string, MemoryIndexItem>()

	const indexPath = path.resolve(import.meta.dirname, 'MEMORY.md')

	let content: string
	try {
		content = await fs.readFile(indexPath, 'utf8') // 索引已存在 → 整读
	} catch {
		content = '# Memory Index' // 首条记忆，索引还不存在 → 初始化
		return memoryIndexMap
	}

	const lines = content.split('\n')
	lines.forEach((line) => {
		// 删除头部的 -
		line = line.slice(1)
		const [time, name, abstract] = line.split(' | ').map((item) => {
			return item.trim()
		})
		if (name && abstract) {
			memoryIndexMap.set(name, { time, name, abstract })
		}
	})
	return memoryIndexMap
}

// 把vectors.json 解析成数组
export async function parseVectorsFromFile(): Promise<VectorItem[]> {
	let vectors: VectorItem[]
	try {
		vectors = JSON.parse(await fs.readFile(path.join(import.meta.dirname, 'vectors.json'), 'utf-8'))
	} catch {
		vectors = []
	}
	return vectors
}

// 通用工具方法，将数组转换成map 例如：[{name: '张三', vector: [1,2,3]}] -> map<name, {name: '张三', vector: [1,2,3]}>
// T[K] 是"索引访问类型"：item[mapKey] 的类型——mapKey 是 K（keyof T 的某个键），取出来的值就是 T[K]。
// K = 'name' 时 T[K] 就是 string；约束 K extends keyof T 保证 mapKey 只能传真实存在的字段名
function arrayToMap<T, K extends keyof T>(arr: Array<T>, mapKey: K): Map<T[K], T> {
	const map = new Map<T[K], T>() // 构造时也带上泛型，否则推断成 Map<any, any>，类型检查就漏了
	for (const item of arr) {
		map.set(item[mapKey], item)
	}
	return map
}

// await historyMemoryToVector()
