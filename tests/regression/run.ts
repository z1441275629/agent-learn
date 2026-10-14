// tests/regression/run.ts —— 07-memory mini_agent 轻量回归用例集（为模块 11 evals 打地基）
//
// 断言口径（LLM 输出不确定，禁止精确全文匹配）：
//   ① expectToolCalls        工具调用名序列，按序严格断言（[] = 期望不调工具）
//   ② expectAnswerIncludes   最终回答必须包含的关键词
//   ③ expectToolResultIncludes（可选）某工具返回结果需包含的标记（如截断标记，任务书第 5 条用）
//   ④ expectMinCompactions   （可选）ContextManager 压缩次数下限（任务书第 9 条用）
//
// 复用 07-memory 现有代码：createAgent/agentLoop（mini_agent.ts，加了 observer 与预算覆盖）、
// ContextManager（context.ts）、MemoryManager（memory.ts，经 mini_agent 启动注册）。
//
// 记忆快照协议：每条用例先清空运行时记忆（MEMORY.md / memories/ / log/），再预置 setup；
// 跑完恢复到启动 run.ts 时的原状（原状快照在用例开始前一次性拍下）。
//
// 用法：node tests/regression/run.ts [--list | --case <id> | 无参数全量跑]
import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createAgent, agentLoop, BUDGET_TOKENS, type ToolCallObserver } from '../../07-memory/mini_agent.ts'

// ---------- 用例定义 ----------
type ExpectToolResult = { tool: string; includes: string }
type RegressionCase = {
	id: string
	name: string
	input: string | string[] // 数组 = 多轮对话（case-09 长对话触发 compaction）
	setup?: { memoryIndex?: string; memories?: Record<string, string> }
	budgetTokens?: number
	expectToolCalls: string[]
	expectAnswerIncludes: string[]
	expectToolResultIncludes?: ExpectToolResult[]
	expectMinCompactions?: number
}

// ---------- 记忆运行时数据的快照 / 预置 / 恢复 ----------
const REGRESSION_DIR = import.meta.dirname
const MEM_ROOT = path.resolve(REGRESSION_DIR, '..', '..', '07-memory') // 与 memory.ts 中 import.meta.dirname 的落盘位置保持一致
const INDEX_PATH = path.join(MEM_ROOT, 'MEMORY.md')
const MEMORIES_DIR = path.join(MEM_ROOT, 'memories')
const LOG_DIR = path.join(MEM_ROOT, 'log')

type DirSnapshot = { existed: boolean; files: Record<string, string> }
type MemorySnapshot = { indexContent: string | null; memories: DirSnapshot; logs: DirSnapshot }

async function snapshotDir(dir: string): Promise<DirSnapshot> {
	const files: Record<string, string> = {}
	try {
		for (const entry of await fs.readdir(dir)) {
			if (entry.endsWith('.md') || entry.endsWith('.log')) {
				files[entry] = await fs.readFile(path.join(dir, entry), 'utf8')
			}
		}
		return { existed: true, files }
	} catch {
		return { existed: false, files: {} } // 目录还不存在（首次运行/全新环境）
	}
}

async function snapshotMemory(): Promise<MemorySnapshot> {
	let indexContent: string | null = null
	try {
		indexContent = await fs.readFile(INDEX_PATH, 'utf8')
	} catch {
		// 索引不存在，不是错误
	}
	return { indexContent, memories: await snapshotDir(MEMORIES_DIR), logs: await snapshotDir(LOG_DIR) }
}

async function wipeMemoryRuntime(): Promise<void> {
	await fs.rm(MEMORIES_DIR, { recursive: true, force: true })
	await fs.rm(LOG_DIR, { recursive: true, force: true })
	await fs.rm(INDEX_PATH, { force: true })
}

async function restoreMemory(snap: MemorySnapshot): Promise<void> {
	await wipeMemoryRuntime()
	if (snap.indexContent !== null) await fs.writeFile(INDEX_PATH, snap.indexContent, 'utf8')
	for (const [dirSnap, dir] of [
		[snap.memories, MEMORIES_DIR],
		[snap.logs, LOG_DIR],
	] as Array<[DirSnapshot, string]>) {
		if (!dirSnap.existed) continue
		await fs.mkdir(dir, { recursive: true })
		for (const [name, content] of Object.entries(dirSnap.files)) {
			await fs.writeFile(path.join(dir, name), content, 'utf8')
		}
	}
}

// 清场后预置本用例的记忆快照（原状由 restoreMemory 在 finally 里恢复）
async function applySetup(c: RegressionCase): Promise<void> {
	await wipeMemoryRuntime()
	if (!c.setup) return
	if (c.setup.memoryIndex !== undefined) await fs.writeFile(INDEX_PATH, c.setup.memoryIndex, 'utf8')
	if (c.setup.memories) {
		await fs.mkdir(MEMORIES_DIR, { recursive: true })
		for (const [name, content] of Object.entries(c.setup.memories)) {
			await fs.writeFile(path.join(MEMORIES_DIR, `${name}.md`), content, 'utf8')
		}
	}
}

// ---------- 跑一条用例并断言 ----------
async function runCase(c: RegressionCase): Promise<string[]> {
	const inputs = Array.isArray(c.input) ? c.input : [c.input]
	const ctx = await createAgent(inputs[0], { budgetTokens: c.budgetTokens ?? BUDGET_TOKENS })
	const calls: { name: string; result: string }[] = []
	const observer: ToolCallObserver = (info) => calls.push({ name: info.name, result: info.result })
	let answer = ''
	for (let i = 0; i < inputs.length; i++) {
		if (i > 0) ctx.add({ role: 'user', content: inputs[i] })
		answer = await agentLoop(ctx, 8, observer) // 与 mini_agent 主流程同参数
	}

	const reasons: string[] = []
	// 基线：不崩、有回答（所有用例隐含断言）
	if (!answer.trim() || answer.includes('模型未返回内容') || answer.includes('达到最大步数')) {
		reasons.push(`无有效回答（answer=${answer.slice(0, 80)}）`)
	}
	// ① 工具名序列（按序严格断言）
	const actual = calls.map((x) => x.name)
	if (JSON.stringify(actual) !== JSON.stringify(c.expectToolCalls)) {
		reasons.push(`工具序列不符：期望 [${c.expectToolCalls.join(' -> ')}]，实际 [${actual.join(' -> ')}]`)
	}
	// ② 回答关键词
	for (const kw of c.expectAnswerIncludes) {
		if (!answer.includes(kw)) reasons.push(`回答缺少关键词「${kw}」（answer=${answer.slice(0, 80)}）`)
	}
	// ③ 工具结果标记
	for (const e of c.expectToolResultIncludes ?? []) {
		if (!calls.some((x) => x.name === e.tool && x.result.includes(e.includes))) {
			reasons.push(`工具 ${e.tool} 的结果未包含「${e.includes}」`)
		}
	}
	// ④ 压缩次数下限
	if (c.expectMinCompactions !== undefined && ctx.stats.compactions < c.expectMinCompactions) {
		reasons.push(`压缩未触发：期望 ≥${c.expectMinCompactions} 次，实际 ${ctx.stats.compactions} 次`)
	}
	return reasons
}

// ---------- CLI ----------
const cases: RegressionCase[] = JSON.parse(await fs.readFile(path.join(REGRESSION_DIR, 'cases.json'), 'utf8'))
const args = process.argv.slice(2)

if (args.includes('--list')) {
	console.log(`共 ${cases.length} 条回归用例：`)
	for (const c of cases) console.log(`  ${c.id}  ${c.name}`)
	process.exit(0)
}

let selected = cases
const caseIdx = args.indexOf('--case')
if (caseIdx !== -1) {
	const id = args[caseIdx + 1]
	if (!id) {
		console.error('用法：node tests/regression/run.ts --case <id>')
		process.exit(2)
	}
	const hit = cases.find((c) => c.id === id)
	if (!hit) {
		console.error(`未找到用例 ${id}（用 --list 查看全部）`)
		process.exit(2)
	}
	selected = [hit]
}

console.log(`mini_agent 回归用例集：共 ${selected.length} 条（上下文预算默认 ${BUDGET_TOKENS} tokens）\n`)
const original = await snapshotMemory()
let passed = 0
for (const c of selected) {
	console.log('='.repeat(72))
	console.log(`[${c.id}] ${c.name}`)
	console.log(`input: ${(Array.isArray(c.input) ? c.input.join(' / ') : c.input).slice(0, 60)}...`)
	try {
		await applySetup(c)
		const reasons = await runCase(c)
		if (reasons.length === 0) {
			passed++
			console.log(`\nPASS [${c.id}] ${c.name}`)
		} else {
			console.log(`\nFAIL [${c.id}] ${c.name}\n  - ${reasons.join('\n  - ')}`)
		}
	} catch (err: any) {
		console.log(`\nFAIL [${c.id}] ${c.name}\n  - 运行异常：${err?.message ?? err}`)
	} finally {
		await restoreMemory(original) // 无论成败都恢复记忆原状
	}
}
console.log('='.repeat(72))
console.log(`\n回归结果：${passed}/${selected.length} PASS`)
process.exit(passed === selected.length ? 0 : 1)
