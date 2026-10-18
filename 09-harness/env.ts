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
import fs from 'node:fs/promises'
import { SANDBOX_DIR } from './sandbox.ts'

const execAsync = promisify(exec)

export interface EnvInfo {
	now: string // 人类可读完整时间，如 2026-10-18 周六 10:32
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
	throw new Error('TODO collectEnv')
}

// 注入块渲染（机械件）：紧凑、写给模型的，不是给人的报表
export function renderEnvBlock(env: EnvInfo): string {
	return [
		'## 环境',
		`- 当前时间：${env.now}（涉及时钟/日期/年龄的问题以它为准，不要用训练数据里的旧时间）`,
		`- 工作目录（run_shell 的执行范围）sandbox/ 内有：${env.sandboxTree.join('、') || '(空)'}`,
		`- 代码仓库状态：${env.git}`,
	].join('\n')
}
