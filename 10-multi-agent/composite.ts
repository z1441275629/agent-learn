/*
模块 10 §7：组合系统——研究员 → 写手 → 审校（毕业装配）

定位：五种模式到此不再是五个 demo，是一条真实产线——
  pipeline（研究→写作）× generator-critic（写作⇄审校打回）的组合拳，产出本模块真实周报。
组装赛的证明方式：**import，不重写**——§6 的 criticPrompt/parseCriticVerdict/首锚契约原样上岗，
§1 的 spawn 隔离、§3 的失败短路、工具面白名单、thinking/skipHooks 配置全部现役。

产线结构：
  原始素材（本模块六节的真实战果——git log 的浓缩，无 PII 无网络）
    → 研究员（提炼成结构化研究简报：要点+数字+来处）
    → 写手（简报 → 周报草稿）
    → 审校（§6 critic 机器：PASS 收工 / FAIL 修订指令喂回写手，熔断交付）

本节两个学习核心（TODO）：
  ① 研究员任务书——「研究」在无检索条件下是什么：把散素材组织成下游能直接用的简报。
     研究员的输出形状就是写手的输入契约（§3 契约纪律的产线版）——想想写手需要什么形状才不用回头猜
  ② 审校的对照物——打回判「事实性」时对照什么：只对照研究简报（一级验：每段只对自己上游负责）
     还是连原始素材一起给（全链验：审校直通源头）？两版各有道理，你选一个并写下为什么
     （提示：一级验省 token 但简报错了审校看不见；全链验贵但错在源头也能逮——这和 §6「判据需要什么
     交接物就要给什么」是同一道题的产线放大版）

金笔记：
  - 失败传播全链路（§1「空手 ≠ 消息丢失」的终考）：研究员挂了 → 产线短路，final 带定位（§3 模式）；
    研究员 ok 但简报薄 → 不短路，交接物带标注走下游（诚实降级在产线上的两级形态）
  - 每段工具面按需配：研究员/写手/审校全是纯文本活 → tools: []；真上检索（02 RAG / 07 记忆）时
    才放开对应工具——「没挂的工具不存在」在产线上的应用
  - 产线的总账 = 各段之和 + 打回轮的双份成本——§9 token 账本直接从这里收数
*/
import { spawn, type SpawnResult } from './spawn.ts'
import { criticPrompt, parseCriticVerdict, type CriticVerdict } from './critic.ts'

// 审校预算：沿用 §6 的值——两轮改不好是指令问题不是轮数问题
const MAX_REVISIONS = 2

// ---------- 原始素材：本模块六节的真实战果（git log 浓缩，自带数字密度） ----------
const SOURCE_MATERIAL = [
	'§1 spawn 原语：子 agent 只回传结论（≤500 字契约+截断双保险），双 token 栏入账。',
	'§2 supervisor：失控探针打满 5 单、熔断拦下第 6 单；隔离实测——主管 prompt 13,749，五个子 agent 合计 92,917。',
	'§3 pipeline：门检三出路（打回/带标注放行/失败短路）；实测抓出打回只记最后一发的账本 bug。',
	'§4 fan-out：并行墙钟 51.1s vs 串行和 72.5s；迟到样本弃子后 0.8s 落地补账。',
	'§5 handoff：皮球探针实测——白名单是软锚不是硬闸，删了「数学运算」四个字模型照样自答。',
	'§6 generator-critic：修前熔断 completion 11,724 → 修后通过 7,557；critic 拆穿用字数统计冒充内容数字。',
].join('\n')

// ---------- TODO ① 你来写：研究员任务书 ----------
// 三段式（§4/§6 同款骨架）：收到什么（原始素材）/ 怎么研究（组织而非创造——每条要点要能指出处）
// / 交付什么形状（写手的输入契约：几条要点、要不要带数字、要不要标来源节号）
// 反面提醒：「研究」不是缩写——纯压缩 §3 提炼段干过了；这里的研究价值在【组织】：分组、标重要性、
// 挑出写手该突出什么——想想下游拿着你的简报要写一篇给新人看的周报，它需要你替它做掉哪些决定
export function researchPrompt(): string {
	// TODO ① 你来填
	return ''
}

// ---------- 写手任务书（骨架已给——你的 TODO 在研究员和审校对照物） ----------
const REPORT_TASK = [
	'任务：基于上游交接物中的研究简报，写一段给团队新人看的技术周报。',
	'输出契约：一个自然段，150 字以内；含本周最重要的 1 项进展与下周方向；数字直接用简报里的，不要自造；不要列表格式。',
].join('\n')

// ---------- TODO ② 你来写：审校的对照物 ----------
// 入参：原始素材、研究简报、待审稿件。返回审校 spawn 的 handoff。
// 你要做的决定：handoff 里装哪几样——只装 简报+稿件（一级验）还是 素材+简报+稿件（全链验）？
// 选定后写一行为什么（注释里），这个决定产线每次审校都在付 token，也在定错误能被哪一级逮住
export function reviewerHandoff(source: string, digest: string, draft: string): string {
	// TODO ② 你来填（当前默认：一级验——你改这里就是改产线验法）
	void source
	return `研究简报：${digest}\n\n待审稿件：${draft}`
}

// ---------- 产线本体 ----------
export interface CompositeResult {
	research: SpawnResult // 研究员（含失败标注路径）
	stages: { draft: string; critic: SpawnResult; verdict: CriticVerdict }[] // 写作⇄审校各轮
	passed: boolean
	finalReport: string // 通过稿 / 熔断最后一稿 / 研究失败定位
	openIssues: string[] // 熔断时的未解决项
	promptTokens: number
	completionTokens: number
}

export async function runCompositeSystem(topic: string): Promise<CompositeResult> {
	let promptTokens = 0
	let completionTokens = 0
	const charge = (r: SpawnResult) => {
		promptTokens += r.promptTokens
		completionTokens += r.completionTokens
	}
	// 第一段：研究员——纯文本组织活（tools: []）；挂了短路，final 带定位（§3 模式，空手 ≠ 消息丢失）
	const research = await spawn(researchPrompt(), { handoff: `原始素材（${topic}）：\n${SOURCE_MATERIAL}`, tools: [], thinking: false, skipSessionEndHooks: true })
	charge(research)
	if (!research.ok) {
		return {
			research,
			stages: [],
			passed: false,
			finalReport: `产线在【研究员】段失败：${research.error ?? research.conclusion}——写作与审校未启动`,
			openIssues: [],
			promptTokens,
			completionTokens,
		}
	}
	// 第二段+第三段：写手 ⇄ 审校（§6 机器 import 上岗——组装赛的证明）
	const stages: CompositeResult['stages'] = []
	let draft = ''
	let passed = false
	let openIssues: string[] = []
	let rounds = 0
	while (rounds <= MAX_REVISIONS) {
		rounds++
		if (rounds === 1) {
			// 首稿：简报 → 写手
			const first = await spawn(REPORT_TASK, { handoff: `研究简报：${research.conclusion}`, tools: [], thinking: false, skipSessionEndHooks: true })
			charge(first)
			draft = first.conclusion
		}
		// 审校：§6 的任务书+解析原样复用，handoff 装配由 TODO ② 决定
		const critic = await spawn(criticPrompt(), { handoff: reviewerHandoff(SOURCE_MATERIAL, research.conclusion, draft), tools: [], thinking: false, skipSessionEndHooks: true })
		charge(critic)
		const verdict = parseCriticVerdict(critic.conclusion)
		stages.push({ draft, critic, verdict })
		if (verdict.passed) {
			passed = true
			break
		}
		openIssues = verdict.issues
		if (rounds > MAX_REVISIONS) break // 熔断：诚实降级
		// 重写：修订指令 + 简报 + 上一稿喂回写手
		const revise = await spawn(
			[REPORT_TASK, `上一稿被审校打回，逐条修订：\n${verdict.issues.map((s, i) => `${i + 1}. ${s}`).join('\n')}`].join('\n\n'),
			{ handoff: `研究简报：${research.conclusion}\n上一稿：${draft}`, tools: [], thinking: false, skipSessionEndHooks: true },
		)
		charge(revise)
		draft = revise.conclusion
	}
	return { research, stages, passed, finalReport: draft, openIssues, promptTokens, completionTokens }
}

export function printCompositeResult(r: CompositeResult) {
	console.log('\n===== 组合系统账单（研究员 → 写手 → 审校） =====')
	console.log(`研究员 [${r.research.ok ? '简报交付' : `失败：${r.research.error?.slice(0, 40)}`}]: ${r.research.conclusion.slice(0, 60)}…`)
	for (const [i, s] of r.stages.entries()) {
		console.log(`  第${i + 1}稿 → 审校 [${s.verdict.passed ? 'PASS' : `FAIL（${s.verdict.issues.length} 项）`}]: ${s.critic.conclusion.slice(0, 50)}`)
	}
	console.log(`结果：${r.passed ? '通过' : r.research.ok ? `熔断（未解决 ${r.openIssues.length} 项——诚实降级交付）` : '研究段短路'}`)
	console.log(`全账：prompt ${r.promptTokens} / completion ${r.completionTokens}（研究员 1 + 写作审校 ${r.stages.length + Math.max(r.stages.length - 1, 0)} 发）`)
	console.log(`\n=== 最终周报 ===\n${r.finalReport}`)
	if (!r.passed && r.openIssues.length) console.log(`\n未解决项：\n${r.openIssues.map((s, i) => `${i + 1}. ${s}`).join('\n')}`)
}

// 冒烟口（花 GLM 配额；TODO ① 未填时研究员收到空任务书 → 大概率空手/假结论 → 走短路路径，先验骨架）：
//   node 10-multi-agent/composite.ts
//   期望：研究员交简报 → 写手成稿 → 审校 1~2 轮 PASS；全账看产线总成本（§9 直接收数）
//   薄料探针：SOURCE_MATERIAL 临时砍到 2 条 → 看简报变薄后审校会不会因「无事实可核」打回（或如实放行）
//   短路探针：researchPrompt 临时写成需要工具的活（如「调用工具查 X」）→ 研究员空手 → 产线短路带定位
const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href
if (isMain) {
	console.log(`\n【组合系统】本模块真实周报生产线\n`)
	const result = await runCompositeSystem('模块10 多Agent六节战果')
	printCompositeResult(result)
}
