// 记忆布局：memory/MEMORY.md（索引：一行一条 = 事实摘要 + 文件名 + 日期）+ memory/memories/*.md（每事实一个文件） 一个事实一个文件会不会文件太多了???
// 给 agent 加两个工具：read_memory(name)（按需读正文）、write_memory(content)（模型自己决定记什么——写入策略 A：模型自主）
// 会话启动只注入索引，不是全文——agent 需要时自己 read_memory。为什么？你在模块 06 用 token 经济学亲手证明过了（渐进式披露）
// 演示脚本（关键设计）：跑两次程序，第二次全新 messages、零历史：
// 会话 1：「我家 5 口人，回答请保持简洁」——看它写不写记忆（不写就在 system prompt 里告诉它有这能力）
// 会话 2：「帮我全家规划买伞预算」——它必须从记忆捞回「5 口人」和「简洁」

import { hybridSearch } from './bm25.ts'
import type { SearchTopKeyItem, ToolDef, WriteMemoryItem } from './type.ts'
import {
	cosine,
	embed,
	findMostSimilarByContent,
	parseMemoryIndex,
	parseVectorsFromFile,
	// search
} from './vector_store.ts'

// ---------- 记忆治理：代码侧向量查重 + 并集合并 ----------
// 为什么在代码里做：去重键不能是模型现编的 name（每次都变），一致性必须代码保证。
// 阈值：0.80。校准数据（test_dedup.ts 实测，embedding-3）：
//   同事实不同排版 0.81~0.96（bullet 列表比散文连句掉 ~0.13）；相邻主题新事实 ≤0.59；无关 ≤0.52。
//   0.80 落在实测的沟里，且偏保守——宁可误建新文件（良性，巡检能收），不可误合并（事实被搅）
export const MERGE_THRESHOLD = 0.8

// 合并策略注入：本文件不 import LLM client（层次干净、避免循环依赖），
// 由 mini_agent 启动时注册——和 registerMemoryTools 同一个模式
export type MergeFn = (oldM: WriteMemoryItem, newM: WriteMemoryItem) => Promise<{ content: string; abstract: string }>
let mergeFn: MergeFn | undefined
export function registerMergeStrategy(fn: MergeFn) {
	mergeFn = fn
}

// 合并 = 事实取并集：旧事实一条不丢，同一事实冲突时以新为准（后说的覆盖先说的，如日期修正）。
// LLM 不可用/失败时兜底为拼接——宁可有冗余，不能丢事实
async function mergeContent(oldM: WriteMemoryItem, newM: WriteMemoryItem): Promise<{ content: string; abstract: string }> {
	const fallback = { content: `${oldM.content}\n${newM.content}`, abstract: newM.abstract }
	if (!mergeFn) return fallback
	try {
		const merged = await mergeFn(oldM, newM)
		return { content: merged.content || fallback.content, abstract: merged.abstract || fallback.abstract }
	} catch (err: any) {
		console.log('合并调用失败，用拼接兜底:', err?.message)
		return fallback
	}
}

// 审计日志统一出口（追加模式——日志类文件天生该追加）
async function appendAudit(line: string): Promise<void> {
	const fs = await import('fs/promises')
	const path = await import('path')
	const logDir = path.resolve(import.meta.dirname, 'log')
	await fs.mkdir(logDir, { recursive: true })
	await fs.writeFile(path.join(logDir, 'memoryRewrite.log'), `${new Date().toISOString()} ${line}\n`, { flag: 'a' })
}

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

export const searchMemoryTool = {
	name: 'search_memory',
	description: '通过关键词检索记忆索引，返回分数最高的3条',
	parameters: {
		type: 'object',
		properties: {
			query: {
				type: 'string',
				description: '要检索的记忆关键词',
			},
		},
		required: ['query'],
	},
	impl: async (args: { query: string }) => {
		// 向量检索
		// const topK: SearchTopKeyItem[] = await search(args.query, 3)
		// 混合检索 向量 + BM25
		const topK: SearchTopKeyItem[] = await hybridSearch(args.query, 3)
		return JSON.stringify(topK)
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
	if (i >= 0) {
		// 同名已存在 → 替换整行，但保留旧行的首次记录日期——
		// 时间戳是记忆的"年龄"：被合并/更新刷成 now 的话，去重巡检"老条目当锚"的排序就乱了（实测翻过车）
		const firstDate = lines[i].split(' | ')[0].replace(/^-\s*/, '').trim()
		lines[i] = `- ${firstDate} | ${name} | ${abstract}`
	} else lines.push(newLine) // 新事实 → 追加一行

	await fs.writeFile(indexPath, lines.join('\n'), 'utf8')
}

// 将记忆存储到向量数据库，我这里就存到 vectors.json 文件中了。
// 双向量：vector = 摘要向量（检索线），contentVector = 正文向量（治理线/查重）
async function saveVector(name: string, vector: number[], contentVector: number[]) {
	const vectors = await parseVectorsFromFile()
	const oldVector = vectors.find((item) => item.name === name)
	if (oldVector) {
		oldVector.vector = vector
		oldVector.contentVector = contentVector
	} else {
		vectors.push({ name, vector, contentVector })
	}
	const fs = await import('fs/promises')
	const path = await import('node:path')
	const vectorPath = path.resolve(import.meta.dirname, 'vectors.json')
	await fs.writeFile(vectorPath, JSON.stringify(vectors))
}

// 满血版 description（策略 A 的实验条件）：判断标准先行、例子只做示意——
// 枚举式例子会被模型当白名单（年龄漏记那个坑），弱化版 description 会污染 A 的实验条件
export const WRITE_TOOL_DESCRIPTION =
	'当了解到关于用户的持久事实或偏好时调用——判断标准：这条信息在未来的对话中还用得上吗？（如：年龄、职业、家庭构成、所在地、作息习惯、表达偏好、长期目标）。一次性的任务细节不要记。时间一律写成绝对日期（如2026年3月1日），不要用"今年""最近"这类相对表述——记忆会被跨年使用。'

export const writeMemoryTool = {
	name: 'write_memory',
	description: WRITE_TOOL_DESCRIPTION,
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
	impl: async (args: WriteMemoryItem) => {
		if (!/^[a-z0-9-]+$/.test(args.name)) {
			// 失败必须是 {error} JSON 而不是纯文本——下游（B 策略钩子/回归测试）靠机读它判断成败，
			// 纯文本错误在钩子里等于静默丢（今天踩实：中文 name 校验失败无声落空，最后还打"完成"）
			return JSON.stringify({ error: '参数错误，记忆条目名称只能包含小写字母、数字和短横线（如 laptop-spec）' })
		}
		const fs = await import('fs/promises')
		const path = await import('path')
		const memoryDir = path.resolve(import.meta.dirname, 'memories')
		await fs.mkdir(memoryDir, { recursive: true })

		// ---------- 治理①：内容向量查重（先于一切写入） ----------
		// 命中 → 不新建文件，走合并路径并沿用旧名（键要稳定）；模型现编的 name 只作参考
		const dup = await findMostSimilarByContent(args.content)
		if (dup && dup.score >= MERGE_THRESHOLD) {
			try {
				const oldPath = path.join(memoryDir, `${dup.name}.md`)
				const oldContent = await fs.readFile(oldPath, 'utf8')
				if (oldContent === args.content) {
					return `记忆 ${dup.name} 内容一致，跳过写入`
				}
				const oldAbstract = (await parseMemoryIndex()).get(dup.name)?.abstract ?? ''
				const merged = await mergeContent({ name: dup.name, content: oldContent, abstract: oldAbstract }, args)
				await appendAudit(`MERGE ${dup.name}.md (相似度${dup.score.toFixed(3)}): 【${oldContent}】+【${args.content}】→【${merged.content}】`)
				await fs.writeFile(oldPath, merged.content, 'utf8')
				await updateIndex(dup.name, merged.abstract)
				const [vec, contentVec] = await embed([merged.abstract, merged.content])
				await saveVector(dup.name, vec, contentVec)
				return `与已有记忆 ${dup.name} 相似度 ${dup.score.toFixed(3)} ≥ ${MERGE_THRESHOLD}，已按并集合并（沿用旧名），未新建文件`
			} catch (err: any) {
				// 查重命中但旧正文读不到（索引/向量与文件漂移了）→ 当作没有重复，走正常写入
				console.log(`查重命中 ${dup.name} 但读取失败，按新记忆处理:`, err?.message)
			}
		}

		// ---------- 正常写入（新增 / 同名覆盖） ----------
		const memoryFilePath = path.join(memoryDir, `${args.name}.md`)
		// fs/promises 没有 exists——用 readFile 探测：读到 = 存在（顺便拿旧内容写审计日志）
		let overwrote = false
		try {
			const oldContent = await fs.readFile(memoryFilePath, 'utf8')
			if (oldContent === args.content) {
				return '记忆内容和原来的内容一致，不需要再重新写入，也不需要记录日志'
			}
			overwrote = true
			await appendAudit(`${args.name}.md: 【${oldContent}】→【${args.content}】`)
		} catch {
			// 读不到 = 新增，无需日志
		}

		await fs.writeFile(memoryFilePath, args.content, 'utf8') // 覆盖和新增都要写正文（原分支只在"不存在"时写——已存在永远更新不了）
		await updateIndex(args.name, args.abstract)
		// 双向量各干各的：摘要向量给检索（search），正文向量给治理（查重）
		const [vec, contentVec] = await embed([args.abstract, args.content])
		await saveVector(args.name, vec, contentVec)
		return (overwrote ? '已覆盖' : '已写入') + `记忆 ${args.name}，索引已更新`
	},
}

// ---------- 治理②：清洗存量重复（一次性巡检） ----------
// 场景：策略 B 每次会话都会重新抽取已知事实，没有查重这道闸，库会被重复记忆灌满
// （实测：family-size/family-members 双份名单，教育背景一条故事拆成 4 份）

// 从索引里删掉一行（按 ` | name |` 片段精确定位，和 updateIndex 同一个匹配规则）
async function removeIndexLine(name: string): Promise<void> {
	const fs = await import('fs/promises')
	const path = await import('path')
	const indexPath = path.resolve(import.meta.dirname, 'MEMORY.md')
	try {
		const lines = (await fs.readFile(indexPath, 'utf8')).split('\n')
		const kept = lines.filter((line) => !line.includes(` | ${name} |`))
		await fs.writeFile(indexPath, kept.join('\n'), 'utf8')
	} catch {
		// 索引还不存在 → 无行可删
	}
}

// 删除一条记忆的三件套：正文文件 + 索引行 + 向量
export async function deleteMemory(name: string): Promise<void> {
	const fs = await import('fs/promises')
	const path = await import('path')
	await fs.rm(path.resolve(import.meta.dirname, 'memories', `${name}.md`), { force: true })
	await removeIndexLine(name)
	const vectors = await parseVectorsFromFile()
	const rest = vectors.filter((item) => item.name !== name)
	if (rest.length !== vectors.length) {
		await fs.writeFile(path.resolve(import.meta.dirname, 'vectors.json'), JSON.stringify(rest))
	}
}

// 存量巡检：按索引时间从老到新过一遍，每条和"保留集"里最相似的比——
// ≥阈值 → LLM 并集合并进更老的条目（老条目当锚，键稳定），删掉自己；否则进保留集
export async function dedupeMemories(opts: { threshold?: number } = {}): Promise<string[]> {
	const threshold = opts.threshold ?? MERGE_THRESHOLD
	const fs = await import('fs/promises')
	const path = await import('path')
	const vectors = await parseVectorsFromFile()
	const indexMap = await parseMemoryIndex()
	const ordered = [...indexMap.values()].sort((a, b) => (a.time < b.time ? -1 : 1))
	const kept: Array<{ name: string; content: string; abstract: string; contentVector: number[]; dirty: boolean }> = []
	const report: string[] = []

	for (const item of ordered) {
		let content: string
		try {
			content = await fs.readFile(path.resolve(import.meta.dirname, 'memories', `${item.name}.md`), 'utf8')
		} catch {
			console.log(`跳过 ${item.name}：正文文件缺失`)
			continue
		}
		const contentVector = vectors.find((v) => v.name === item.name)?.contentVector
		if (!contentVector) {
			kept.push({ name: item.name, content, abstract: item.abstract, contentVector: [], dirty: false })
			continue
		}
		let target: (typeof kept)[number] | undefined
		let bestScore = -1
		for (const k of kept) {
			if (!k.contentVector.length) continue
			const score = cosine(contentVector, k.contentVector)
			if (score > bestScore) {
				bestScore = score
				target = k
			}
		}
		if (target && bestScore >= threshold) {
			const merged = await mergeContent({ name: target.name, content: target.content, abstract: target.abstract }, { name: item.name, content, abstract: item.abstract })
			await appendAudit(`CLEANUP MERGE ${item.name} → ${target.name} (相似度${bestScore.toFixed(3)}): 【${target.content}】+【${content}】→【${merged.content}】`)
			target.content = merged.content
			target.abstract = merged.abstract
			target.dirty = true
			await deleteMemory(item.name)
			report.push(`${item.name} 并入 ${target.name}（相似度 ${bestScore.toFixed(3)}）`)
		} else {
			kept.push({ name: item.name, content, abstract: item.abstract, contentVector, dirty: false })
		}
	}

	// 吸收过新内容的锚点：正文/索引/双向量都要刷新
	for (const k of kept) {
		if (!k.dirty) continue
		await fs.writeFile(path.resolve(import.meta.dirname, 'memories', `${k.name}.md`), k.content, 'utf8')
		await updateIndex(k.name, k.abstract)
		const [vec, contentVec] = await embed([k.abstract, k.content])
		await saveVector(k.name, vec, contentVec)
	}
	return report
}

export class MemoryManager {
	// private memoryDir: string;
	constructor(_memoryDir?: string) {
		// this.memoryDir = memoryDir
	}
	static registerMemoryTools(registry: Map<string, ToolDef>, strategy: 'A' | 'B' | 'AB' = 'AB') {
		registry.set(readMemoryTool.name, readMemoryTool)
		registry.set(searchMemoryTool.name, searchMemoryTool)
		// B 条件下不注册 write_memory：模型看不到这个工具，写入完全由会话结束钩子负责——条件才干净
		if (strategy !== 'B') registry.set(writeMemoryTool.name, writeMemoryTool)
	}

	static async getSystemPrompt(includeWrite = true) {
		// 		const fs = await import('fs/promises')
		// 		const path = await import('path')
		// 		// 读索引文件 MEMORY.md——必须和 updateIndex 写的路径一致（两处各自 resolve 一旦改布局就会漂移，更好的做法是抽一个共享常量）
		// 		const memoryIndexPath = path.resolve(import.meta.dirname, 'MEMORY.md')
		// 		let memoryIndexContent: string
		// 		try {
		// 			memoryIndexContent = await fs.readFile(memoryIndexPath, 'utf8')
		// 		} catch {
		// 			// 第一次运行时索引还不存在（write_memory 还没被调过）——不是错误，"暂无记忆"即可
		// 			memoryIndexContent = '（暂无记忆）'
		// 		}
		// 		// 记忆读取方案1 把索引文件的内容都加到系统提示词中
		// 		// 索引膨胀怎么办：① 纪律——索引必须守住一行一条；② 真大到装不下时，就轮到检索型记忆
		// 		// （对 memories/ 做语义/关键词检索，按需捞回）——那是本模块第二周的功课，现在不用解
		// 		return `你有跨会话的长期记忆。记忆索引（一行一条 = 日期 | 名称 | 摘要），需要详情时用 read_memory(name) 读取：\n【${memoryIndexContent}】\n
		// 当了解到关于用户的持久事实或偏好时调用——判断标准：这条信息在未来的对话中还用得上吗？（如：年龄、职业、家庭构成、所在地、作息习惯、表达偏好、长期目标）。一次性的任务细节不要记。
		// 需要增加记忆时用 write_memory(name, content, abstract) 写入`

		// 记忆读取方案2 记忆的索引不是全部放到系统提示词中，而是根据用户的问题搜索一下分数高的前几个索引
		// 读取引导常驻；写入引导（策略 A）按开关拼装——B 条件下模型不知道自己"能写"，条件才干净
		const writeGuidance = `
当了解到关于用户的持久事实或偏好时调用 write_memory(name, content, abstract) 保存——判断标准：这条信息在未来的对话中还用得上吗？（如：年龄、职业、家庭构成、所在地、作息习惯、表达偏好、长期目标）。一次性的任务细节不要记。`
		return `你有跨会话的长期记忆。
当用户问问题时，如果发现需要用户的基本信息，你先用 search_memory(query) 检索分数高的3个索引，然后需要时再按需用 read_memory(name) 读取记忆详情。
如果只是闲聊或者与用户基本信息没关系的对话，不需要检索记忆，比如下面这个例子就不需要记忆信息：今天天气怎么样？${includeWrite ? writeGuidance : ''}`

		// 记忆写入方案A 在提示词中告诉模型，了解到就记录。
		// 记忆写入方案B 会话跑完之后，再单独跑一次会话从内容中提取记忆并保存
		// 				return `
		// 你有跨会话的长期记忆。
		// 当用户问问题时，如果发现需要用户的基本信息，你先用 search_memory(query) 检索分数高的3个索引，然后需要时再按需用 read_memory(name) 读取记忆详情。
		// 如果只是闲聊或者与用户基本信息没关系的对话，不需要检索记忆，比如下面这个例子就不需要记忆信息：今天天气怎么样？
		// 现在指的是当前时间，不是模型训练的时间
		// `
	}
}

// // test
// (async () => {
//   // await writeMemoryTool.impl({name:'family-size', content:'家里5口人', abstract:'家庭人口'})

//   // await writeMemoryTool.impl({name:'family-size', content:'家里6口人', abstract:'家庭人口'})
//   // const data = await readMemoryTool.impl({name: 'family-size'})
//   // const data = await readMemoryTool.impl({name: 'family'})
//   // const data = await searchMemoryTool.impl({ query: '我媳妇是谁'})
//   // console.log(data)
// })()
