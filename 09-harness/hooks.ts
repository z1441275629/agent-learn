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

// TODO 你来写（~8 行）：按注册顺序跑 pre-hook 管线
// 1. 逐个 await hook(toolName, args)；任何一个 blocked → 立即短路返回（后面的不再跑）
// 2. 返回 args !== undefined → 更新流水中的 args（改写链：下一个 hook 看到的是改后的）
// 3. hook 抛错 → 按拦截处理（blocked = 错误信息）+ console.error——热路径上的 hook 坏了
//    不该放行也不该崩循环，fail-closed
export async function runPreHooks(toolName: string, args: any): Promise<PreHookResult> {
	throw new Error('TODO runPreHooks')
}

// TODO 你来写（~5 行）：按注册顺序跑 post-hook 管线，result 链式传递
// 每个 hook 的返回值是下一个的输入，最后返回终态。
// hook 抛错 → 跳过这个 hook + 大声报，用上一个 result 继续——post 是增益性质，
// 一个脱敏 hook 坏了不该把整个工具结果废掉（注意：这和 pre 的 fail-closed 方向相反，为什么？）
export async function runPostHooks(toolName: string, args: any, result: string): Promise<string> {
	throw new Error('TODO runPostHooks')
}

// TODO 你来写（~4 行）：会话结束钩子逐个 void 触发（不 await——不阻塞最终回答返回），
// 每个 hook 的异常自己消化（07 #18：unawaited 钩子的异常逃逸 = unhandled rejection = 崩进程）
export function runSessionEndHooks(ctx: ContextManager): void {
	throw new Error('TODO runSessionEndHooks')
}

// ---------- 内置 hook（示例住户 + §3 验收标的；import 本模块即注册，与 tools.ts 同款模式） ----------
const AUDIT_PATH = path.resolve(import.meta.dirname, 'log', 'tool-audit.log')

// 脱敏 post-hook【先注册】：结果里的手机号/身份证打码。
// 注册顺序在这里是安全问题：审计 hook 若排在前面，日志里存的就是未脱敏的原文——
// 审计日志本身也是数据出口。post 管线按注册顺序跑，先脱敏后审计
registerPostHook((toolName, args, result) => {
	return Promise.resolve(
		result
			.replace(/1[3-9]\d{9}/g, (m) => m.slice(0, 3) + '****' + m.slice(-4))
			.replace(/\d{17}[\dXx]/g, (m) => m.slice(0, 4) + '**************' + m.slice(-2)),
	)
})

// 审计 post-hook【后注册】：每次工具调用一行流水（07 appendAudit 的正式版）。
// 拿到的已是脱敏+截断后的终态；失败大声报但不影响结果（审计坏了不能废掉工具调用）
registerPostHook(async (toolName, args, result) => {
	try {
		await fs.appendFile(AUDIT_PATH, `[${new Date().toISOString()}] ${toolName} ${JSON.stringify(args).slice(0, 200)} → ${result.slice(0, 200)}\n`, 'utf8')
	} catch (err: any) {
		console.error('⚠ 审计 hook 写入失败:', err?.message)
	}
	return result // 只看不动
})
