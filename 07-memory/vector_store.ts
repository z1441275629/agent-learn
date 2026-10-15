/* 
第一步动手：向量库 + search_memory 工具
复用你 Phase 1 的 RAG 代码（02-rag/rag.ts 的 embedding + 余弦相似度部分），全部手写，不要引向量数据库：

07-memory/vector_store.ts（~50 行）：
embed(texts)：调 embedding API（见下面的坑）
cosine(a, b)：从你的 rag.ts 抄回来
search(query, k)：query 向量 vs 所有记忆向量，返回 top-k 的 {name, score, 摘要}
持久化就一个 vectors.json（几十条记忆不配用数据库）：{name, vector}[]，write_memory 时 append，启动时 load
search_memory(query) 工具挂进 registry——模型多一个语义检索入口，和 read_memory 并存
write_memory 接线：写入正文的同时把向量也存进 vectors.json（文件 + 索引 + 向量，三位一体）
三个坑预告：

端点：embedding 大概率不在 Coding Plan 端点上——给 embedding 单独建一个走 api/paas/v4 的 client，模型用智谱 embedding-3（按量计费，很便宜）。401/404 就换端点，你 README 里自己写过这两个端点的区别
维度一致：查询和存储必须同一个 embedding 模型，混了维度余弦直接 NaN
它查名字可能不如第一周：「媳妇叫什么」这种专有名词精确查询，向量可能输给字符串匹配——这不是 bug，是纯向量检索的固有盲区，这正是本周后半程 BM25 混合检索的动机。先撞上它，记下失效案例
验收：拿你已有的 4 条真实记忆当测试集（这是你自己的数据，比任何假数据都好）：问「用户家里几口人」→ 命中 family-size；问「用户的童年」→ 命中 childhood-river。再故意问一个「媳妇叫什么」看它翻不翻车。把命中结果和分数贴来。

搞定这个，第二Half就是写入策略 B（会话结束钩子自动抽取——你的年龄漏记就是它的立项理由）和 A/B 对比实验。开工。
*/

import OpenAI from 'openai'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Chunk, MemoryIndexItem, VectorItem } from './type.ts'
import { keyof } from 'zod'

// embedding 走按量计费的标准端点（Coding Plan 只包聊天模型）。
// 报"余额不足/无权限"时两个选择：① bigmodel 充 1~2 元（embedding-3 很便宜）；
// ② 注册硅基流动（有免费的 BAAI/bge-large-zh-v1.5），改下面两行即可
const EMBED_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4'
const EMBED_MODEL = 'embedding-3'

const apiKey = process.env.GLM_API_KEY
const embedClient = new OpenAI({ apiKey, baseURL: EMBED_BASE_URL })

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
function cosine(a: number[], b: number[]): number {
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
		console.log('记忆索引和向量数据完全对应，没有缺失的索引向量')
		return
	}
	console.log(`有${missList.length}条数据缺少向量，现在补上`)
	const texts = missList.map((item) => item.abstract)
	const allVectors = await embed(texts)
	const list = missList.map((item, index) => ({ name: item.name, vector: allVectors[index] }))
	await batchSaveVectors(list)
	console.log('缺失向量补充完成，数据清洗完成')
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
	console.log(`所有的向量名称:${[...vectorMap.keys()]}`)
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
