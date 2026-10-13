// 记忆布局：memory/MEMORY.md（索引：一行一条 = 事实摘要 + 文件名 + 日期）+ memory/memories/*.md（每事实一个文件） 一个事实一个文件会不会文件太多了???
// 给 agent 加两个工具：read_memory(name)（按需读正文）、write_memory(content)（模型自己决定记什么——写入策略 A：模型自主）
// 会话启动只注入索引，不是全文——agent 需要时自己 read_memory。为什么？你在模块 06 用 token 经济学亲手证明过了（渐进式披露）
// 演示脚本（关键设计）：跑两次程序，第二次全新 messages、零历史：
// 会话 1：「我家 5 口人，回答请保持简洁」——看它写不写记忆（不写就在 system prompt 里告诉它有这能力）
// 会话 2：「帮我全家规划买伞预算」——它必须从记忆捞回「5 口人」和「简洁」

import type { ToolDef } from './type.ts'

// export const memoryPrompt = '记忆布局：memory/MEMORY.md（索引：一行一条 = 事实摘要 + 文件名 + 日期）+ memory/memories/*.md（每事实一个文件）'

export const readMemoryTool = {
	name: 'read_memory',
	description: '通过名称读取记忆条目',
	parameters: {
		type: 'object',
		properties: {
			name: {
				type: 'string',
				description: '记忆条目名称, 只能使用MEMORY.md索引文件中记录的名称',
			},
		},
		required: ['name'],
	},
	impl: async (args: { name: string }) => {
		if (!/^[a-z0-9-]+$/.test(args.name)) {
			return '参数错误，记忆条目名称只能包含小写字母、数字和短横线'
		}
		const fs = await import('fs/promises')
		const path = await import('path')
		const memoryFilePath = path.resolve(import.meta.dirname, 'memories', `${args.name}.md`)
		try {
			return await fs.readFile(memoryFilePath, 'utf8')
		} catch (err: any) {
			return '读取记忆文件错误: ' + err.message
		}
	},
}

// ---------- 更新索引（write_memory 的家政部分） ----------
// 索引行格式：- 2026-10-13 | name | 摘要
// Node 模式：整读 → split('\n') 按行处理 → 整写。索引才几十上百行，
// 不需要 readline 流式逐行读——那是 GB 级日志文件的工具。
// 查找用格式片段 ` | name |` 精确匹配，不用裸 includes(name)——"family" 会误中 "family-size" 那行
async function updateIndex(name: string, abstract: string): Promise<void> {
	const fs = await import('fs/promises')
	const path = await import('path')
	const indexPath = path.resolve(import.meta.dirname, 'MEMORY.md')
	const newLine = `- ${new Date().toISOString()} | ${name} | ${abstract}`

	let content: string
	try {
		content = await fs.readFile(indexPath, 'utf8') // 索引已存在 → 整读
	} catch {
		content = '# Memory Index' // 首条记忆，索引还不存在 → 初始化
	}

	const lines = content.split('\n')
	const i = lines.findIndex((line) => line.includes(` | ${name} |`))
	if (i >= 0)
		lines[i] = newLine // 同名已存在 → 替换整行（"我改主意了"的更新路径；想保留首次日期就从旧行取日期段）
	else lines.push(newLine) // 新事实 → 追加一行

	await fs.writeFile(indexPath, lines.join('\n'), 'utf8')
}

export const writeMemoryTool = {
	name: 'write_memory',
	// description: '当你了解到关于用户的持久事实、用户信息或偏好时调用（家庭情况、表达偏好、长期目标）；不要记录一次性的任务细节',
  description: '当了解到关于用户的持久事实或偏好时调用——判断标准：这条信息在未来的对话中还用得上吗？（如：年龄、职业、家庭构成、所在地、作息习惯、表达偏好、长期目标）。一次性的任务细节不要记。',
	parameters: {
		type: 'object',
		properties: {
			content: {
				type: 'string',
				description: '记忆条目内容',
			},
			name: {
				type: 'string',
				description: '记忆条目名称, 需要符合文件名规范，命名按正则/^[a-z0-9-]+$/要求来。如果本地已经存在同名记忆，将被覆盖',
			},
			abstract: {
				type: 'string',
				description: '一句话摘要，会显示在索引行里——模型只看它决定要不要读全文，质量决定记忆的命中率。摘要不是记忆内容的全部，不要超过30个汉字',
			},
		},
		required: ['content', 'name', 'abstract'],
	},
	impl: async (args: { name: string; content: string; abstract: string }) => {
		if (!/^[a-z0-9-]+$/.test(args.name)) {
			return '参数错误，记忆条目名称只能包含小写字母、数字和短横线'
		}
		const fs = await import('fs/promises')
		const path = await import('path')
		const memoryDir = path.resolve(import.meta.dirname, 'memories')
		await fs.mkdir(memoryDir, { recursive: true })
		const memoryFilePath = path.join(memoryDir, `${args.name}.md`)

		// fs/promises 没有 exists——用 readFile 探测：读到 = 存在（顺便拿旧内容写审计日志）
		let overwrote = false
		try {
			const oldContent = await fs.readFile(memoryFilePath, 'utf8')
			if (oldContent === args.content) {
				return '记忆内容和原来的内容一致，不需要再重新写入，也不需要记录日志'
			}
			overwrote = true
			const logDir = path.resolve(import.meta.dirname, 'log')
			await fs.mkdir(logDir, { recursive: true })
			// flag: 'a' = 追加模式；默认 'w' 会把日志整个覆盖，永远只剩最后一条记录
			await fs.writeFile(path.join(logDir, 'memoryRewrite.log'), `${new Date().toISOString()} ${args.name}.md: 【${oldContent}】→【${args.content}】\n`, { flag: 'a' })
		} catch {
			// 读不到 = 新增，无需日志
		}

		await fs.writeFile(memoryFilePath, args.content, 'utf8') // 覆盖和新增都要写正文（原分支只在"不存在"时写——已存在永远更新不了）
		await updateIndex(args.name, args.abstract)
		return (overwrote ? '已覆盖' : '已写入') + `记忆 ${args.name}，索引已更新`
	},
}

export class MemoryManager {
	// private memoryDir: string;
	constructor(_memoryDir?: string) {
		// this.memoryDir = memoryDir
	}
	static registerMemoryTools(registry: Map<string, ToolDef>) {
		registry.set(readMemoryTool.name, readMemoryTool)
		registry.set(writeMemoryTool.name, writeMemoryTool)
	}

	static async getSystemPrompt() {
		const fs = await import('fs/promises')
		const path = await import('path')
		// 读索引文件 MEMORY.md——必须和 updateIndex 写的路径一致（两处各自 resolve 一旦改布局就会漂移，更好的做法是抽一个共享常量）
		const memoryIndexPath = path.resolve(import.meta.dirname, 'MEMORY.md')
		let memoryIndexContent: string
		try {
			memoryIndexContent = await fs.readFile(memoryIndexPath, 'utf8')
		} catch {
			// 第一次运行时索引还不存在（write_memory 还没被调过）——不是错误，"暂无记忆"即可
			memoryIndexContent = '（暂无记忆）'
		}
		// 索引膨胀怎么办：① 纪律——索引必须守住一行一条；② 真大到装不下时，就轮到检索型记忆
		// （对 memories/ 做语义/关键词检索，按需捞回）——那是本模块第二周的功课，现在不用解
		return `你有跨会话的长期记忆。记忆索引（一行一条 = 日期 | 名称 | 摘要），需要详情时用 read_memory(name) 读取：\n【${memoryIndexContent}】\n 当了解到关于用户的持久事实或偏好时调用——判断标准：这条信息在未来的对话中还用得上吗？（如：年龄、职业、家庭构成、所在地、作息习惯、表达偏好、长期目标）。一次性的任务细节不要记。需要增加记忆时用 write_memory(name, content, abstract) 读取`
	}
}

// // test
// (async () => {
//   // await writeMemoryTool.impl({name:'family-size', content:'家里5口人', abstract:'家庭人口'})

//   // await writeMemoryTool.impl({name:'family-size', content:'家里6口人', abstract:'家庭人口'})
//   // const data = await readMemoryTool.impl({name: 'family-size'})
//   const data = await readMemoryTool.impl({name: 'family'})
//   console.log(data)
// })()
