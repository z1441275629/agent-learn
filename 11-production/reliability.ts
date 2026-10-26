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

纪律：重试是白名单行为——transient 之外（unknown 也含在内）一律不重试，
fail-fast 带原文返回。和权限闸同思想：不确定时按「不再发」处理。
*/
import { spawn, type SpawnResult } from '../10-multi-agent/spawn.ts'

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

// ---------- 可靠 spawn：分类 + 退避重试 + 可观测 ----------
export interface RetryPolicy {
	retries?: number // 瞬态错误最多重试几轮（默认 2——第三次还瞬态，大概率不是偶发）
	baseBackoffMs?: number // 首轮退避（默认 2000，每轮翻倍——2s/4s；对 5xx/限流的常规节奏）
	onRetry?: (attempt: number, errorClass: ErrorClass, error: string) => void // 重试可观测：产线接 trace.event
}

// spawn 的可选参数对象（NonNullable 剥掉 Parameters 元组里的 undefined——直接 extends 联合类型会炸出数字键）
type SpawnOptions = NonNullable<Parameters<typeof spawn>[1]>
export interface ReliableSpawnOptions extends SpawnOptions {
	retry?: RetryPolicy
}

export async function spawnReliable(task: string, opts?: ReliableSpawnOptions): Promise<SpawnResult> {
	const { retry, ...spawnOpts } = opts ?? {}
	const { retries = 2, baseBackoffMs = 2000, onRetry } = retry ?? {}
	for (let attempt = 0; ; attempt++) {
		const r = await spawn(task, spawnOpts)
		if (r.ok) return r
		const ec = classifyError(r.error)
		if (!retryable(ec) || attempt >= retries) return r // fail-fast：非瞬态 / 预算用尽，原文带回落给调用方
		onRetry?.(attempt + 1, ec, r.error ?? '')
		// 退避翻倍：500ms 起？不——首轮就 2s：瞬态故障的恢复尺度是秒级不是毫秒级，太快的重试只是排队
		await new Promise((res) => setTimeout(res, baseBackoffMs * 2 ** attempt))
	}
}

// ---------- 机械探针（零 LLM 成本）：分类表 + 重试策略行为 ----------
// node 11-production/reliability.ts
const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href
if (isMain) {
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
	let pass = 0
	for (const [name, err, want] of cases) {
		const got = classifyError(err)
		const ok = got === want
		if (ok) pass++
		console.log(`${ok ? '✓' : '✗'} ${name} → ${got}${ok ? '' : `（期望 ${want}）`}`)
	}
	// 重试白名单抽查：quota/auth/unknown 必须不重试
	const nonRetryable = (['quota', 'auth', 'bad-request', 'unknown'] as ErrorClass[]).every((c) => !retryable(c))
	console.log(`${nonRetryable ? '✓' : '✗'} 重试白名单：仅 transient（quota/auth/bad-request/unknown 全不重试）`)
	console.log(`\n分类探针：${pass}/${cases.length} 通过`)
}
