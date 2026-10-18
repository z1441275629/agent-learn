/*
模块 09 §5：会话持久化与 resume

08 的 plan-checkpoint 是雏形（status 在 schema 里，序列化即检查点）；§5 补另一半：
对话本身的落盘与恢复。06 的双账本设计在这里闭环——ledger 只增不删、view 可派生，
天生就是「存储」：落盘落 ledger，恢复重放 add()（双写），view 自动重建。

resume 的三个边界（想清楚再动手）：
  ① tool_call_id 配对：assistant 的 tool_calls 和 tool 结果在 ledger 里天然有序成对，
     原样重放就是合法历史——API 收的是「历史事实」，不重执行、不重扣费
  ② 环境已变：历史工具结果是「当时的事实」，保留；但 system 里的环境块（时钟/文件树）
     是旧会话采的——resume 时必须重采刷新（env.ts 的 refreshEnvBlock），
     否则模型拿着上次的时钟继续推理，§4 白做
  ③ 步数预算：resume 后 maxSteps 重新起算（新一轮 8 步）——历史长度的账归
     ensureBudget 的压缩机制管，不归 step 管
*/
import fs from 'node:fs/promises'
import path from 'node:path'

const SESSIONS_DIR = path.resolve(import.meta.dirname, 'sessions')

// 会话 id：时间戳 + 随机后缀（同秒多次会话不撞名）。用 UTC 没问题——id 只要求
// 唯一且按时间可排序，不承担「给人看时间」的语义（那是 getNow 的活，别学它踩 UTC 坑）
export function newSessionId(): string {
	return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '_' + Math.random().toString(36).slice(2, 8)
}

// ledger 落盘（信封格式）：先写 .tmp 再 rename——原子写。写一半被杀，毁的是 tmp，旧档完好；
// 最坏留个孤儿 .tmp，读取只认 id.json，不受干扰
// 标题保全是关键：没传新标题就保留档上已有的（L3 用户改的名）——每步 checkpoint 都会调这里，
// 不保全的话无标题信封会把用户的改名冲掉（读-改-写，主动堵住微缩版的同步缝）
// 纪律：永不抛——落盘失败大声报 console.error 后正常返回（持久化是增强不是依赖，
// 存档坏了不能把正在跑的会话也带崩）
export async function saveSession(id: string, ledger: any[], title?: string): Promise<void> {
	try {
		await fs.mkdir(SESSIONS_DIR, { recursive: true })
		const existing = (await readSessionDoc(id))?.title
		const doc: SessionDoc = { title: title ?? existing, ledger }
		const filePath = path.join(SESSIONS_DIR, `${id}.json`)
		const tmp = filePath + '.tmp'
		await fs.writeFile(tmp, JSON.stringify(doc))
		await fs.rename(tmp, filePath)
	} catch (err: any) {
		console.error(`保存会话 ${id} 失败，错误: ${err?.message}`)
	}
}

// 存档文档（信封格式）：title 是 L3 用户状态（改过名才有），ledger 是账本本体。
// 同一份文档同一次原子写——标题永远不会和账本失联，也没有孤儿文件
export interface SessionDoc {
	title?: string
	ledger: any[]
}

// 读档（格式演进的核心）：老档是裸数组（本节早期存的），新档是信封——双形状都认
export async function readSessionDoc(id: string): Promise<SessionDoc | null> {
	const filePath = path.join(SESSIONS_DIR, `${id}.json`)
	let parsed: any
	try {
		parsed = JSON.parse(await fs.readFile(filePath, 'utf-8'))
	} catch (err: any) {
		console.error(`获取会话 ${id} 失败，error: ${err?.message}`)
		return null
	}
	// 双形状分派——格式演进的坑，亲手踩
	// ① Array.isArray(parsed) → 老格式裸数组：包成 { ledger: parsed } 返回（读时迁移，不改盘）
	// ② Array.isArray(parsed?.ledger) → 新格式信封：原样返回
	// ③ 其他 → null（'hello' 那类形状洞继续把关）
	// 提示：这条兼容分支是永久债务——它要活到所有老档被覆写成新格式为止，删不掉
	if (Array.isArray(parsed)) {
		return { ledger: parsed }
	}
	if (Array.isArray(parsed?.ledger)) {
		return parsed
	}
	return null
}

// 读取账本（兼容层：resume 重放只关心账本，不关心标题）
export async function loadSession(id: string): Promise<any[] | null> {
	return (await readSessionDoc(id))?.ledger ?? null
}

// ---------- 历史会话与归档 ----------
// 设计决策（先想清楚再动手）：
//   ① 会话状态（完成/中断）是派生数据不是存储数据——ledger 的尾巴就是事实：
//     末条是纯 assistant（无 tool_calls）= 已完成；末条是 tool/user = 中断（被杀/步数耗尽）。
//     单独的状态文件会和账本之间留同步缝——刚用原子写堵上的洞，别自己再挖
//   ② 归档是人的决定，不可派生，真要存——但不用状态文件：挪进 sessions/archive/ 子目录
//     就是归档（挪回来就是恢复）。文件系统即状态，没有第二份账要对齐
//   ③ 目录里的 .tmp 是原子写的替死鬼（写一半被杀的残留）——列表按扩展名过滤，
//     「去重」的真实含义是这个
//   ④ 标题三层：L1 首条消息截断（deriveSessionMeta，零成本）< L3 用户改名（存信封 title 字段）；
//     L2 会话结束模型摘要留白——点亮处：session-end hook 再挂一个（§3 挂载点第四次复用）
export interface SessionMeta {
	id: string
	title: string // 首条 user 消息的前 N 字——时间戳文件名之外唯一可读的线索
	status: '已完成' | '中断' | '损坏'
	msgCount: number
}

// 从整本 ledger 派生 title 和 status（本功能的 学习核心）
// 1. title：ledger.find(m => m.role === 'user')?.content 的前 24 字（没有 user 消息 → '(无用户消息)'）；
//    content 理论上可能是数组（多模态），String() 兜一下再 slice
// 2. status：看末条——role === 'assistant' 且没有 tool_calls → '已完成'；
//    其他（tool / user 结尾 = 中途被杀或步数耗尽，maxSteps 中止的尾巴正是 tool）→ '中断'；
//    ledger 为空 → '损坏'
// 3. msgCount：ledger.length
export function deriveSessionMeta(id: string, ledger: any[]): SessionMeta {
	const firstUserMsg = ledger.find((item) => item.role === 'user')
	const title = String(firstUserMsg?.content ?? '')?.slice(0, 12) || '无用户消息'
	const lastMsg = ledger.at(-1)
	let status: SessionMeta['status'] = '损坏'
	if (!lastMsg) {
		status = '损坏'
	} else {
		if (lastMsg.role === 'assistant' && !lastMsg?.tool_calls?.length) {
			status = '已完成'
		} else {
			status = '中断'
		}
	}
	return {
		id,
		title,
		status,
		msgCount: ledger.length,
	}
}

// 机械件：扫目录出历史会话列表——只认顶层 .json（.tmp 过滤掉、archive/ 不在扫描范围）
export async function listSessions(): Promise<SessionMeta[]> {
	let files: string[]
	try {
		files = await fs.readdir(SESSIONS_DIR)
	} catch {
		return [] // 目录还没有 = 一条会话都没跑过，不是错误
	}
	const metas: SessionMeta[] = []
	for (const name of files) {
		if (!name.endsWith('.json')) continue
		const id = name.slice(0, -'.json'.length)
		const doc = await readSessionDoc(id)
		if (!doc) {
			metas.push({ id, title: '(读不了档)', status: '损坏', msgCount: 0 })
			continue
		}
		const meta = deriveSessionMeta(id, doc.ledger)
		if (doc.title !== undefined) meta.title = doc.title // 显示优先级：L3 用户改过 > L1 派生截断
		metas.push(meta)
	}
	// 新的在前：id 是 ISO 时间戳前缀，字典序 = 时间序，倒排即最近优先
	return metas.sort((a, b) => (a.id < b.id ? 1 : -1))
}

// 改名（L3）：读-改-写整份文档。会话不存在/读不了 → false（调用方大声报）
export async function renameSession(id: string, title: string): Promise<boolean> {
	const doc = await readSessionDoc(id)
	if (!doc) return false
	await saveSession(id, doc.ledger, title) // 显式传 title 即覆盖；原子写与标题保全都复用
	return true
}

// 归档 = 挪窝（同卷 rename，原子；逆操作同款挪回来）。不删数据——归档不是销毁
export async function archiveSession(id: string): Promise<boolean> {
	const from = path.join(SESSIONS_DIR, `${id}.json`)
	const toDir = path.join(SESSIONS_DIR, 'archive')
	try {
		await fs.mkdir(toDir, { recursive: true })
		await fs.rename(from, path.join(toDir, `${id}.json`))
		return true
	} catch (err: any) {
		console.error(`归档会话 ${id} 失败：${err?.message}`)
		return false
	}
}
