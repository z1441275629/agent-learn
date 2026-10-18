/*
模块 09 §4：环境注入——模型怎么「知道自己在哪」（骨架——采集核心你来填）

ZCode/Claude Code 的 system prompt 里有一段 environment_details：cwd、git 分支与脏文件、
文件树、当前时间——模型对环境的全部认知从这里来（它看不见进程，只看得见上下文）。

注入机制你已经复用过两次：07 记忆索引常驻、08 计划常驻（systemExtra）——本节第三次接同一根管子。
反面教材就在自家代码里：抽取提示词硬编码「今天是2026年」——绝对时间也会腐烂
（PITFALLS #19 的变体），明年这句话就开始撒谎。环境注入的第一件事就是让时钟走真实时间。

时机决策（推导，不实验——实验预算只花在直觉算不出的结论上）：
  会话开始注入一次 vs 每轮重注入，在「无提示词缓存」下 token 成本完全相同——
  system 块无论内容变不变，每次请求都原样重发。真实差异是：
  - 一次注入：内容稳定；代价是过期（文件树变了模型不知道、会话跨小时后时间是旧的）
  - 每轮重注入：内容新鲜；代价是每轮 IO + 内容漂移——若供应商有提示词缓存，刷新即缓存失效，
    反而更贵。GLM 按量计费暂无隐式缓存，教学版按「一次注入」实现，这个账记在注释里
  生产参照：Claude Code 的 environment_context 带时钟且周期性刷新——两头都要，就得付两头钱
*/
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import fs from 'node:fs/promises'
import { SANDBOX_DIR } from './sandbox.ts'

const execAsync = promisify(exec)

export interface EnvInfo {
	now: string // 人类可读完整时间，如 2026-10-18 周六 10:32
	platform: string // process.platform（win32/darwin/linux）——shell 方言由它决定
	sandboxTree: string[] // 沙箱顶层条目名（run_shell 的家——模型该知道里面有什么）
	git: string // 如 'master（3 个未提交变更）' 或 '非 git 环境'
}

// TODO 你来写（~15 行）：采集环境快照
// 1. now：new Date() 格式化成 年-月-日 星期几 时:分——星期用 getDay() 映射数组
//    （0 是周日，从 '周日' 起排，别漏）
// 2. sandboxTree：fs.readdir(SANDBOX_DIR)；目录可能不存在，catch 时返回 []（渲染层兜底显示"空"）
// 3. git：这里查的是**仓库本身**（教学版特批：诊断环境不是跑模型命令，不走沙箱）——
//    execAsync('git branch --show-current') 拿分支（失败 = 非 git 环境），
//    execAsync('git status --porcelain') 的输出按非空行数 = 未提交变更数
export async function collectEnv(): Promise<EnvInfo> {
	const now = getNow()
	const platform = os.platform()
	const [sandboxTree, git] = await Promise.all([getSandboxTree(), getGit()])
	return {
		now,
		platform,
		sandboxTree,
		git,
	}
}

export const weeksMap = new Map([
	[0, '星期日'],
	[1, '星期一'],
	[2, '星期二'],
	[3, '星期三'],
	[4, '星期四'],
	[5, '星期五'],
	[6, '星期六'],
])
// @return 年-月-日 星期几 时:分
export function getNow(): string {
	const now = new Date()
	const [year, month, day, hour, minute] = [now.getFullYear(), now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes()].map((item) => padStart(item))
	const date = [year, month, day].join('-')
	const week = weeksMap.get(now.getDay())
	const time = `${hour}:${minute}`
	return `${date} ${week} ${time}`
}

function padStart(str: string | number, aimLength = 2, fillString = '0') {
	str = `${str}`
	return str.padStart(aimLength, fillString)
}

export async function getGit() {
	let currentBranch = ''
	try {
		const branchRes = await execAsync('git branch --show-current')
		if (branchRes.stderr) {
			console.error(`git branch --show-current 报错：${branchRes.stderr}，当前不是一个git仓库`)
			currentBranch = ''
		} else {
			currentBranch = branchRes.stdout.replace('\n', '')
		}

		let gitStatus = ''
		const { stderr, stdout } = await execAsync('git status --porcelain')
		if (stderr) {
			console.error(`git status --porcelain 报错：${stderr}`)
		} else {
			// 总结下stdout -> 改动文件个数
			//  M 09-harness/agent.ts
			//  M 09-harness/env.ts
			const modifies = stdout.split('\n').filter((item) => item)
			gitStatus = `${modifies.length}个文件变动`
		}
		return currentBranch ? `当前分支：${currentBranch}, 当前仓库状态：${gitStatus}` : '当前不是在一个git仓库中'
	} catch (err: any) {
		console.error(`获取git信息报错：${err?.message}，认为当前不是一个git仓库`)
		return '当前不是在一个git仓库中'
	}
}

export async function getSandboxTree() {
	try {
		return await fs.readdir(SANDBOX_DIR)
	} catch (err: any) {
		console.error(`读取沙箱目录失败，返回[]`)
		return []
	}
}

// 注入块渲染（机械件）：紧凑、写给模型的，不是给人的报表。
// 定界符规矩（§5 定稿）：成对标签锁区间——比 ## 标题强在「结束位置不靠猜」+「内容碰撞免疫」
// （记忆里存段 markdown 也不会误伤边界）；生产参照：Claude Code 的 environment details 同款
export function renderEnvBlock(env: EnvInfo): string {
	return [
		'<env>',
		`- 当前时间：${env.now}（涉及时钟/日期/年龄的问题以它为准，不要用训练数据里的旧时间）`,
		`- 操作系统：${env.platform === 'win32' ? 'Windows，shell 是 cmd——列目录用 dir（没有 ls）、查看文件用 type（没有 cat）、路径分隔符是反斜杠' : env.platform}`,
		`- 你的 shell 工作目录：${SANDBOX_DIR}——run_shell 的 cwd 锁定在此，相对路径都落在这个目录里；当前内容：${env.sandboxTree.join('、') || '(空)'}`,
		`- 所在代码仓库（背景信息，不是你的工作目录）：${env.git}`,
		'</env>',
	].join('\n')
}

// §5 resume 用：重采环境并替换 system 里的旧环境段——离线期间时钟/文件树已过期，
// 拿旧环境继续推理 = 从错误的「今天」出发，§4 白做。§4 之前存的老会话没有环境段 → 追加
export async function refreshEnvBlock(ctx: { ledger: any[] }): Promise<void> {
	const block = renderEnvBlock(await collectEnv())
	const sys = ctx.ledger.find((m) => m.role === 'system')
	if (!sys) return
	// ctx.add 推的是同一个对象引用（双账本共享消息对象）——改 content 两本账同时生效
	sys.content = sys.content.includes('<env>')
		? sys.content.replace(/<env>[\s\S]*?<\/env>/, block) // 成对标签锁死区间——旧版按「下一个 ## 或结尾」猜边界，把不按标题格式的计划段整个吃过
		: sys.content + '\n' + block // 更老的存档（标签制之前）没有环境段 → 追加
}

// console.log(await collectEnv())
