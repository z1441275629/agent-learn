// 产品核心配置（personal-agent/core/ 只放可复用、无课程/演示语义的代码）
//
// 存储根目录可配置：PA_DATA_DIR（相对 cwd 或绝对路径都行）；缺省 personal-agent/data。
// 会话、图片、以后的记忆/RAG 索引都挂在同一个根下——备份/迁移只搬一个目录。

import path from 'node:path'

export interface AppConfig {
	/** 运行数据根：sessions/、以后 memories/、rag/ 都在它下面 */
	dataDir: string
}

export function loadConfig(): AppConfig {
	const fromEnv = process.env.PA_DATA_DIR?.trim()
	const dataDir = fromEnv
		? path.resolve(process.cwd(), fromEnv)
		: path.join(import.meta.dirname, '..', 'data')
	return { dataDir }
}
