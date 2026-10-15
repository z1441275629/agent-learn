// 工具实现函数
export type ToolImpl = (args: any) => Promise<string>
// 工具定义
export type ToolDef = {
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

// 向量item
export type VectorItem = {
	name: string
	vector: number[]
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
