/*
模块 11 §7：可靠性层——重试/超时/降级收拢（模块 08 散装的系统化）

散装现状（收拢前，各管一层）：
  09 hooks.ts    withTimeout        —— hook 层超时（单个工具调用）
  10 fanout.ts   spawnWithDeadline  —— 任务层超时弃子（fan-out 迟到样本）
  10 composite   熔断（修订预算）+ §6 成本护栏（token 硬顶）—— 产线层止损
  缺的一层：**瞬态故障重试**——今天实录（§6 e2a）：429 直接把研究员段打失败，零重试

本层补什么（应用层重试，SDK 内建 maxRetries 之上的增量）：
  ① 错误分类先于重试决策——quota 429 重试永远不成功（配额窗口问题，不是时间问题），
     fail-fast 把「等重置」的决策交回调用方；只有已知瞬态才值得退避重试
  ② 重试可观测——onRetry 回调把重试轮次上报（产线接 trace.event，图里看得见）
  ③ 跨步一致性——agentLoop 中途崩掉，从 spawn 层整重来（干净上下文，不续崩到一半的会话）
  ④ 配额 failover（§7 增补）——quota 429 等待无用但换路有用：切备用档（默认回落小档
     glm-5.3-flash 按量端点，跨配额池——5h/周/月墙是账号/端点级，同端点备用=假备用）。
     只切一次不做链式互切（备用也 quota=按量余额尽，fail-fast 带原文回落）；
     切换不占重试预算、不退避——换路不是重试同一条路，配额也不因 2s 等待恢复

纪律：重试是白名单行为——transient 之外（unknown 也含在内）一律不重试，
fail-fast 带原文返回。和权限闸同思想：不确定时按「不再发」处理。
failover 同纪律的镜像：quota 才换路（auth 换路也没用——key 坏了备用的也坏，
如果备用配了独立 key 才值得换，那是配置问题不是本层问题）。
*/
import { spawn, type SpawnResult } from '../10-multi-agent/spawn.ts'
import { BACKUP_MODEL } from '../09-harness/llm.ts'

// ---------- 错误分类：重试决策的前置 ----------
// 分类依据是错误文本+状态码的组合模式（跨平台尽力），不是精确 API——分类错顶多多等一轮/少等一轮
export type ErrorClass = 'transient' | 'quota' | 'auth' | 'bad-request' | 'unknown'

export function classifyError(error: string | undefined): ErrorClass {
	const msg = error ?? ''
	if (/429/.test(msg)) {
		// 429 两面：配额耗尽重试无用，纯限流值得退避——签名锚 quota 词本身，
		// 不锚 exceeded（「Rate limit exceeded」也含 exceeded，探针逮过这个误触）
		return /quota|配额|余额/i.test(msg) ? 'quota' : 'transient'
	}
	if (/\b(401|403)\b/.test(msg) || /invalid[_ ]?api[_ ]?key|unauthorized/i.test(msg)) return 'auth'
	if (/\b400\b/.test(msg) || /mismatch type|invalid request/i.test(msg)) return 'bad-request'
	// 瞬态家族：5xx / 网络 / 超时 / 连接重置——等一下再试大概率好
	// timeout 要兼容「timed out」（带空格变体，探针逮过）
	if (/\b5\d{2}\b/.test(msg) || /time.?d?[ _-]?out|econn|fetch failed|network|socket/i.test(msg)) return 'transient'
	return 'unknown'
}

// 是否值得重试：只有已知瞬态。quota/auth/bad-request 是确定性失败，重试是烧时间；
// unknown 也不重——重试是白名单行为，不是黑名单行为（不确定时按不再发处理）
const retryable = (c: ErrorClass) => c === 'transient'

// ---------- 配额 failover：决策先于切换（分类先于重试的同族） ----------
// 切不切是纯决策（quota 才切 / 只切一次 / 配了备用才切）——独立成函数，探针零成本打矩阵；
// 真切换在 spawnReliable 循环里（置 useBackupModel 重发，agentLoop 的备用档优先于小档路由）
export function shouldFailover(errorClass: ErrorClass, alreadySwitched: boolean, backupConfigured: boolean): boolean {
	return errorClass === 'quota' && !alreadySwitched && backupConfigured
}

// ---------- 可靠 spawn：分类 + 退避重试 + 配额 failover + 可观测 ----------
export interface RetryPolicy {
	retries?: number // 瞬态错误最多重试几轮（默认 2——第三次还瞬态，大概率不是偶发）
	baseBackoffMs?: number // 首轮退避（默认 2000，每轮翻倍——2s/4s；对 5xx/限流的常规节奏）
	onRetry?: (attempt: number, errorClass: ErrorClass, error: string) => void // 重试可观测：产线接 trace.event
	onFailover?: (model: string, error: string) => void // failover 可观测：切到哪个档、因为什么
}

// spawn 的可选参数对象（NonNullable 剥掉 Parameters 元组里的 undefined——直接 extends 联合类型会炸出数字键）
type SpawnOptions = NonNullable<Parameters<typeof spawn>[1]>
export interface ReliableSpawnOptions extends SpawnOptions {
	retry?: RetryPolicy
	_spawn?: typeof spawn // 测试 seam：failover 路径配额健康时永远不触发（同 §6 dataGuard 的归因纪律——
	// 没法触发的防线验证不了）；注入假 spawn 零成本验「quota→切档→重发」的切换路径真的能跑
}

export async function spawnReliable(task: string, opts?: ReliableSpawnOptions): Promise<SpawnResult> {
	const { retry, _spawn: spawnImpl = spawn, ...spawnOpts } = opts ?? {}
	const { retries = 2, baseBackoffMs = 2000, onRetry, onFailover } = retry ?? {}
	let switched = false // failover 只切一次——主⇄备链式互切是死循环的另一种写法
	for (let attempt = 0; ; attempt++) {
		const r = await spawnImpl(task, spawnOpts)
		if (r.ok) return r
		const ec = classifyError(r.error)
		// 配额 failover：决策器判可切 → 置备用档立即重发（不退避：配额墙不因等待移动；不占重试预算：换路≠重试）
		if (shouldFailover(ec, switched, BACKUP_MODEL !== '')) {
			switched = true
			spawnOpts.useBackupModel = true
			onFailover?.(BACKUP_MODEL, r.error ?? '')
			attempt = -1
			continue
		}
		if (!retryable(ec) || attempt >= retries) return r // fail-fast：非瞬态 / 预算用尽 / 备用档也挂，原文带回落给调用方
		onRetry?.(attempt + 1, ec, r.error ?? '')
		// 退避翻倍：500ms 起？不——首轮就 2s：瞬态故障的恢复尺度是秒级不是毫秒级，太快的重试只是排队
		await new Promise((res) => setTimeout(res, baseBackoffMs * 2 ** attempt))
	}
}

// ---------- 机械探针（零 LLM 成本）：分类表 + 重试白名单 + failover 决策/切换路径 ----------
// node 11-production/reliability.ts
const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href
if (isMain) {
	let pass = 0
	let total = 0
	const check = (name: string, ok: boolean, detail = '') => {
		total++
		if (ok) pass++
		console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `（${detail}）`}`)
	}

	// ① 分类表
	const cases: [string, string | undefined, ErrorClass][] = [
		['quota 429（§6 实录原文）', '429 You have exceeded the 5-hour usage quota. It will reset at 2026-10-26 19:13:20', 'quota'],
		['限流 429', '429 Rate limit exceeded, too many requests', 'transient'],
		['5xx', '500 Internal Server Error', 'transient'],
		['网络', 'fetch failed', 'transient'],
		['超时', 'Request timed out after 60000ms', 'transient'],
		['鉴权', '401 Invalid API key provided', 'auth'],
		['参数', '400 Mismatch type openapi.Thinking', 'bad-request'],
		['未知', 'something completely novel', 'unknown'],
	]
	for (const [name, err, want] of cases) check(`${name} → ${want}`, classifyError(err) === want)
	// 重试白名单抽查：quota/auth/unknown 必须不重试
	check('重试白名单：仅 transient', (['quota', 'auth', 'bad-request', 'unknown'] as ErrorClass[]).every((c) => !retryable(c)))

	// ② failover 决策矩阵：quota 才切 / 只切一次 / 没配不切
	check('failover：quota+未切+已配 → 切', shouldFailover('quota', false, true))
	check('failover：transient 不切（退避重试管）', !shouldFailover('transient', false, true))
	check('failover：auth 不切（key 坏换档不救）', !shouldFailover('auth', false, true))
	check('failover：已切过不切（不做链式互切）', !shouldFailover('quota', true, true))
	check('failover：没配备用不切（回落 fail-fast）', !shouldFailover('quota', false, false))

	// ③ 切换路径（seam 注入假 spawn——配额健康时唯一能验 failover 真跑通的路）：
	//    A 主档 quota → 切备用 → 成功：第二发必须带着 useBackupModel、onFailover 上报、结果 ok
	//    B 备用也 quota → fail-fast：返回备用档原文，不再切回主档
	//    C transient 重试不受 failover 干扰：不切档、重试后成功
	const mk = (ok: boolean, error?: string) => ({ ok, conclusion: ok ? 'done' : '', promptTokens: 1, completionTokens: 1, elapsedMs: 1, ...(error ? { error } : {}) })
	{
		const seen: (boolean | undefined)[] = []
		let foModel = ''
		const r = await spawnReliable('t', {
			_spawn: async (_t, o) => {
				seen.push(o?.useBackupModel)
				return seen.length === 1 ? mk(false, '429 You have exceeded the 5-hour usage quota') : mk(true)
			},
			retry: { onFailover: (m) => (foModel = m), baseBackoffMs: 1 },
		})
		check('切换A：quota→备用→成功', r.ok && seen.length === 2 && seen[1] === true && foModel !== '', `ok=${r.ok} 发数=${seen.length} 第二发备用=${seen[1]} 上报=${foModel}`)
	}
	{
		const seen: (boolean | undefined)[] = []
		const r = await spawnReliable('t', {
			_spawn: async (_t, o) => {
				seen.push(o?.useBackupModel)
				return mk(false, '429 Insufficient balance in your account (余额不足)')
			},
			retry: { baseBackoffMs: 1 },
		})
		// 正确形态：[null, true]——第一发主档、切备用、第二发备用也 quota、停（没有第三发=不切回主档）
		check('切换B：备用也 quota → fail-fast 不互切', !r.ok && seen.length === 2 && seen[0] !== true && seen[1] === true, `发数=${seen.length} 档位序列=${JSON.stringify(seen)}`)
	}
	{
		const seen: (boolean | undefined)[] = []
		const r = await spawnReliable('t', {
			_spawn: async (_t, o) => {
				seen.push(o?.useBackupModel)
				return seen.length === 1 ? mk(false, '500 Internal Server Error') : mk(true)
			},
			retry: { baseBackoffMs: 1 },
		})
		check('切换C：transient 走重试不走 failover', r.ok && seen.length === 2 && !seen[1], `ok=${r.ok} 备用档被误置=${seen[1]}`)
	}
	console.log(`\n可靠层探针：${pass}/${total} 通过`)
}
