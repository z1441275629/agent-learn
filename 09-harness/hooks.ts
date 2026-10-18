/*
模块 09 §3：Hooks——工具调用前后的拦截器（骨架——三条管线你来填）

已经写过三个 hook 而不自知：
  - 07 appendAudit / 08 job-audit = post-hook（审计）
  - dispatch 里的 truncateToolResult = post-hook（结果改写——截断就是它）
  - extractMemories = 会话结束钩子（本节迁进来，不再散落在 agentLoop 的两个出口）
§3 做的事：把「散装内联」提成正式的挂载点 + 统一管线——以后加拦截器不改 dispatch 一行。

三种挂载点：
  pre-hook    (toolName, args) → { blocked?, args? }
              拦截 / 改写参数（例：参数规范化、强制字段）
  post-hook   (toolName, args, result) → result（链式改写）
              审计 / 脱敏 / 截断——最后一个 hook 的输出说了算
  session-end (ctx) → 会话结束（正常答完 / maxSteps 中止都算）
              extractMemories 是第一个住户

核心排序：pre-hook 在权限闸【前】（dispatch 已按此接线，想清楚为什么）：
  - 改写先发生 → 权限判定的是最终参数：hook 把 echo 改成 del，权限看到 del 并拒绝
    若放权限后 = 改写逃过审判，hook 一行代码绕过整个权限系统
  - pre-hook 经过一切调用（含被拒的）；post-hook 只见真执行了的——
    被拒调用想进审计，得在 dispatch 的 deny 分支单独记一行（post 管线到不了那里）
  代价：hook 对所有调用都跑（包括注定被拒的）——CPU 便宜，值
  对照 ZCode/Claude Code：PreToolUse 同样在权限询问前，且 hook 的 allow 决定能跳过询问——
  生产版把 hook 当作比权限更细的控制层，前提始终是「hook 是受信代码」

hook 三纪律（07 #18 unawaited 钩子的老规矩延伸）：
  1. hook 抛错不许炸循环——管线按 fail-closed 处理 + 大声报
  2. hook 不许慢——它在每次工具调用的热路径上（审计用 appendFile，别同步 IO）
  3. 改写要可观测——审计行记改写前后，否则出了事查不到是谁改的
*/
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ContextManager } from './context.ts'

// ---------- 类型与注册表 ----------
export interface PreHookResult {
	blocked?: string // 拒绝原因（命中 → dispatch 返回 error 给模型）
	args?: any // 改写后的参数（undefined = 不改）
}
export type PreHook = (toolName: string, args: any) => PreHookResult | Promise<PreHookResult>
export type PostHook = (toolName: string, args: any, result: string) => string | Promise<string>
export type SessionEndHook = (ctx: ContextManager) => void | Promise<void>

const preHooks: PreHook[] = []
const postHooks: PostHook[] = []
const sessionEndHooks: SessionEndHook[] = []

export function registerPreHook(hook: PreHook) {
	preHooks.push(hook)
}
export function registerPostHook(hook: PostHook) {
	postHooks.push(hook)
}
export function registerSessionEndHook(hook: SessionEndHook) {
	sessionEndHooks.push(hook)
}

// §7 对照补的缺口：钩子超时——此前 runPreHooks 无限 await，一个挂死的钩子让整个循环陪葬
// （ZCode 的 hooks.json 每个钩子自带 timeoutMs: 120000——外部进程钩子的标准配置，
// 我们是同进程钩子，10s 已经宽裕）。实现是 Promise.race，两个诚实边界：
//   ① 输掉的 Promise 不会被取消——JS 没有 cancellation，钩子还在后台跑，只是没人再等它的结果
//   ② 计时器分出胜负后必须清掉，否则空定时器拖住进程退出
// 超时 rejection 落进各管线已有的 catch——语义自动正确：pre fail-closed（按拦截）、
// post fail-open（保住上一个 result）、session-end 大声报。HOOK_TIMEOUT_MS 走 env 是给探针留的口子
const HOOK_TIMEOUT_MS = Number(process.env.HOOK_TIMEOUT_MS) || 10_000

// 入参放宽为 T | Promise<T>：钩子签名本来就是「同步返回或 Promise 二选一」（PreHook/PostHook 的
// 返回类型）——已是 Promise 则 Promise.resolve 原样穿透，不额外包一层
function withTimeout<T>(value: T | Promise<T>, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout>
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`钩子 ${label} 超过 ${HOOK_TIMEOUT_MS}ms 未返回`)), HOOK_TIMEOUT_MS)
	})
	const p = Promise.resolve(value)
	// 诊断挂件：race 对输家只「观察到」不处理——超时已判、流程已走，但输家 eventual 的报错
	// 正是「为什么慢」的病因，必须留痕（只挂日志，不改变任何流向；输家迟到地成功 resolve
	// 则无声——不是错误，记了就是噪音）。同一个 p，race 照常订阅，两不耽误
	p.catch((err: any) => console.error(`钩子 ${label} 在超时放弃后报错（病因诊断）：${err?.message}`))
	return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

// 按注册顺序跑 pre-hook 管线
// 1. 逐个 await hook(toolName, args)；任何一个 blocked → 立即短路返回（后面的不再跑）
// 2. 返回 args !== undefined → 更新流水中的 args（改写链：下一个 hook 看到的是改后的）
// 3. hook 抛错/超时 → 按拦截处理（blocked = 错误信息）+ console.error——热路径上的 hook 坏了
//    不该放行也不该崩循环，fail-closed
export async function runPreHooks(toolName: string, args: any): Promise<PreHookResult> {
	for (const hook of preHooks) {
		try {
			const hookRes = await withTimeout(hook(toolName, args), toolName)
			const { blocked, args: reWriteArgs } = hookRes
			if (blocked) {
				return hookRes
			}
			if (reWriteArgs !== undefined) {
				// 更新流水中的 args（改写链：下一个 hook 看到的是改后的）
				console.log(`工具${toolName}的参数由${JSON.stringify(args).slice(0, 120)}改为${JSON.stringify(reWriteArgs).slice(0, 120)}`)
				args = reWriteArgs
			}
		} catch (err: any) {
			const desc = `工具${toolName}的前置hook执行时报错：${err.message}`
			console.error(desc)
			return { blocked: desc }
		}
	}
	return { args }
}

// 按注册顺序跑 post-hook 管线，result 链式传递
// 每个 hook 的返回值是下一个的输入，最后返回终态。
// hook 抛错 → 跳过这个 hook + 大声报，用上一个 result 继续——post 是增益性质，
// 一个脱敏 hook 坏了不该把整个工具结果废掉（注意：这和 pre 的 fail-closed 方向相反，为什么？）
export async function runPostHooks(toolName: string, args: any, result: string): Promise<string> {
	for (const hook of postHooks) {
		try {
			const hookRes = await withTimeout(hook(toolName, args, result), toolName)
			if (hookRes !== result) {
				console.log(`\n后置钩子的结果由 ${result} 变为 ${hookRes} \n`)
				result = hookRes
			}
		} catch (err: any) {
			console.error(`${toolName}的后置钩子执行时发生错误，错误信息：${err.message}。用上一个result【${result}】继续`)
		}
	}
	return result
}

// 会话结束钩子逐个 void 触发（不 await——不阻塞最终回答返回），
// 每个 hook 的异常自己消化（07 #18：unawaited 钩子的异常逃逸 = unhandled rejection = 崩进程）
export function runSessionEndHooks(ctx: ContextManager): void {
	for (const hook of sessionEndHooks) {
		// .then 包一层：同步抛错和异步 rejection 都汇进同一个 catch；超时同罚
		Promise.resolve()
			.then(() => withTimeout(hook(ctx), 'session-end'))
			.catch((err: any) => console.error(`会话结束钩子执行错误，错误信息：${err?.message}`))
	}
}

// ---------- 内置 hook（示例住户 + §3 验收标的；import 本模块即注册，与 tools.ts 同款模式） ----------
const AUDIT_PATH = path.resolve(import.meta.dirname, 'log', 'tool-audit.log')

// 手机号和身份证号脱敏——只用于日志副本。
// 位置是威胁模型定的：管道里的业务数据要干活（read_memory 取回手机号是给用户报数的，
// 在管线上脱敏 = 用户问自己手机号、模型收到 173****7986——实测踩过）。
// 数据给模型看不是威胁，发出去才是：外传走工具，有沙箱+confirm 闸；
// 日志是数据出口，在这里脱敏副本，业务数据不动
const redact = (text: string) => text.replace(/1[3-9]\d{9}/g, (m) => m.slice(0, 3) + '****' + m.slice(-4)).replace(/\d{17}[\dXx]/g, (m) => m.slice(0, 4) + '**************' + m.slice(-2))

// 审计 post-hook：每次工具调用一行流水（07 appendAudit 的正式版）。
// args 和 result 都在写入时脱敏——先脱敏再截断（先截会把打码截坏、边界外的原文漏脱）
const auditHook: PostHook = async (toolName, args, result) => {
	try {
		await fs.appendFile(AUDIT_PATH, `[${new Date().toISOString()}] ${toolName} ${redact(JSON.stringify(args)).slice(0, 200)} → ${redact(result).slice(0, 200)}\n`, 'utf8')
	} catch (err: any) {
		console.error('⚠ 审计 hook 写入失败:', err?.message)
	}
	return result // 只看不动（返回给管道的仍是原文）
}

registerPostHook(auditHook)
