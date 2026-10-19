// 工具实现函数
export type ToolImpl = (args: any) => Promise<string>
// 工具定义
export type ToolDef = {
	name?: string
	description: string
	parameters: object
	impl: ToolImpl
	maxResultTokens?: number
}

export type Chunk = {
	file: string
	index: number
	text: string
}

// 向量item：vector = 摘要向量（检索线，search 用）；contentVector = 正文向量（治理线，查重/合并判断用）
export type VectorItem = {
	name: string
	vector: number[]
	contentVector?: number[]
}

// 记忆索引item
export type MemoryIndexItem = {
	time: string
	name: string
	abstract: string
}

export type SearchTopKeyItem = {
	name: string
	score: number
	abstract: string
}

export type WriteMemoryItem = {
	name: string
	content: string
	abstract: string
}

export type ToolCallParams = {
	function: {
		name: string
		arguments: string
	}
}
