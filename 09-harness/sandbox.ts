/*
模块 09 §2：沙箱执行——run_shell 的三层拦截（骨架——拦截核心你来填）

定位：§1 管的是「谁点头」（allow/confirm/deny），§2 管的是「点头之后命令本身干不干净」。
两道独立的闸：权限批了 run_shell，模型来一句 "npm test && del ..\..\*.txt"——
权限层看的是工具调用合不合规，沙箱层看的是命令内容有没有毒。少了沙箱层，
confirm 弹出来给人看的是盲盒（人只会无脑 y）——拦截器把已知毒的先筛掉，人工确认才有意义。

run_shell 的三件套（对照你每天用的 ZCode：跑命令前同样过这几关）：
  timeout  —— 模型幻觉出挂死命令（交互式、死循环）时超时杀进程，进程不陪葬
  cwd 锁死 —— 只能在沙箱目录（./sandbox）里干活，目录外的文件摸不着
  三层拦截 —— 见下

三层拦截（顺序从廉到贵，先便宜的跑）：
  ① 黑名单：原子段的命令名直接比对（rm/del/format/…）
  ② 组合拆解：把 && || ; | & 拆成原子段逐段过①③——不拆的话
     "npm test && rm -rf /" 里毒藏在第二段，只看整串就是纸糊的
     （07 #7 的 includes 逃逸同族，这次是分隔符版）
  ③ 路径逃逸：段里的 .. 穿越、绝对路径盘符——cwd 锁死要配套它才闭环，
     否则 del sandbox\..\..\memories\*.md 从沙箱里伸手到沙箱外

拦截哲学（金笔记）：
  - 拒绝要「大声 + 给理由」：返回 {error: "被拦截: 原因"}，模型看得懂能换命令重试；
    静默失败会教模型学会「换个姿势再试」——那是在训练越狱
  - 黑名单永远列不全：它是兜底不是防线。真正的防线 = 白名单（参数级规则 run_shell(npm *)，
    §2 配套把 permissions.ts 的 matchRule 参数级 TODO 一起做掉）+ cwd + 超时
  - 教学版已知绕过（不防，写出来是诚实）：命令替换 $(del x) 与反引号、环境变量拼接、引号混淆。
    真防住要「解析成 AST 再判」（生产级 shell parser）——认清边界，别假装安全
*/
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import { registerTool } from './tools.ts'
import type { ToolDef } from './type.ts'

const execAsync = promisify(exec)

// 沙箱根目录：run_shell 的 cwd 永远是它（gitignore 掉——运行时工作区，不是代码）
export const SANDBOX_DIR = path.resolve(import.meta.dirname, 'sandbox')
const TIMEOUT_MS = 10_000

// ① 黑名单：一个原子段（已拆好、无分隔符）的命令名是否危险（~6 行）
// 1. 段首 token：trim 后按空白切第一个——"del x.txt" 的命令名是 del
// 2. 与 BLACKLIST 比对。清单你来定，想 30 秒：unix 的 rm、Windows 的 del/rd/format，
//    还有谁？（提示：move/copy 能覆写、reg 动注册表、taskkill 杀进程……教学版挡 5~8 个即可，
//    重点是体会「列不全」这个结论本身）
const BLACKLIST: string[] = ['del', 'rd', 'format', 'rm', 'move', 'copy', 'reg', 'taskkill']
function isBlacklisted(segment: string): boolean {
	const [cmd] = segment.trim().split(/\s+/)
	return BLACKLIST.includes(cmd)
}

// TODO ② 组合拆解：命令串 → 原子段数组（~4 行）
// 正则一把梭：/\s*(?:&&|\|\||[;|&])\s*/ 切分（长分隔符 && || 在单字符 ; | & 之前匹配，
// 顺序写错会把 && 切成两个空段）。npm test && rm -rf / 应拆出 ["npm test", "rm -rf /"]
function splitCommand(command: string): string[] {
	throw new Error('TODO splitCommand')
}

// TODO ③ 路径逃逸：段里是否出现越出沙箱的路径字面量（~5 行）
// 三种形态：.. 穿越（路径段里有 ..）、绝对路径（盘符 X:\ 或以 / \ 开头）、~ 开头
// 07 #7 的 pathIsInDir 是「解析后检查目标在不在目录里」（语义级）；
// 这里是「扫字面量有没有越狱意图」（字符串级）——弱一档但便宜，教学版的取舍
function hasPathEscape(segment: string): boolean {
	throw new Error('TODO hasPathEscape')
}

// TODO 串联：三层按 ②拆解 → 逐段 ①黑名单 + ③路径逃逸 跑一遍（~6 行）
// 返回 null = 放行；返回 string = 拦截原因（喂给模型的 error 里要带上是哪段、违反哪层）
function inspectCommand(command: string): string | null {
	throw new Error('TODO inspectCommand')
}

export const runShellTool: ToolDef = {
	description: '在沙箱目录里执行 shell 命令（10 秒超时，只能访问沙箱目录，危险命令会被拦截）',
	parameters: {
		type: 'object',
		properties: {
			command: { type: 'string', description: '要执行的命令，如：echo hello、node -v' },
		},
		required: ['command'],
	},
	maxResultTokens: 400, // 命令输出会刷屏——工具级截断必须设（06 的纪律：源头减量）
	impl: async (args) => {
		const command = args.command as string
		// 三层拦截在执行前；拦截 = {error} 返回给模型（永不抛——dispatch 的约定）
		const blocked = inspectCommand(command)
		if (blocked) return JSON.stringify({ error: `命令被沙箱拦截：${blocked}` })
		try {
			const { stdout, stderr } = await execAsync(command, {
				cwd: SANDBOX_DIR, // cwd 锁死：进程的"脚"被钉在沙箱里
				timeout: TIMEOUT_MS, // 到点杀进程——幻觉出的挂死命令不陪葬
				windowsHide: true,
			})
			return JSON.stringify({ ok: true, stdout: stdout.slice(0, 2000), stderr: stderr.slice(0, 500) })
		} catch (err: any) {
			// 超时/非零退出/命令不存在都到这——错误是给模型的信息，不是崩溃的理由
			return JSON.stringify({ error: String(err?.message || err).slice(0, 300), stdout: err?.stdout?.slice(0, 500) ?? '' })
		}
	},
}

// 启动时注册一次（与 registerMemoryTools 同款模式：注册是启动动作）
export function registerSandboxTools() {
	// 沙箱目录不存在则建；失败不阻塞启动（真用到时 exec 的 cwd 会大声暴露问题）
	fs.mkdir(SANDBOX_DIR, { recursive: true }).catch(() => {})
	registerTool('run_shell', runShellTool)
}
