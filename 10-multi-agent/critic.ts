/*
模块 10 §6：generator-critic（生成-评审）——模式五：带否决权的 pipeline（骨架——两个学习核心你来填）

模式一句话：生成者出稿、评审者打回、循环直到通过或熔断。§3 门检和它血脉相连但分工明确：
  门检（check 函数）：判【形状】——机器可判、零成本、判不了「好不好」
  critic（spawn 一个 agent）：判【质量】——模型判断、真金白银、能说「这段不行因为…」
§3 骨架里埋的那句话在此兑现：「判据里混进质量判断，gate 就成了廉价的 critic，两头不占」——
本节把「不占」补上：真 critic 拿真预算干活。

结构上它是 pipeline 打回循环的升级：打回理由不再来自 check 函数，来自另一个 agent 的评审意见；
被拒稿不再是「带标注放行」的降级路径，而是【修订指令】喂回生成者重写——批评被消费，不是被记录。

本节两个学习核心（TODO）：
  ① critic 的评审标准怎么写才不是玄学——checklist 化：把「写得好」拆成可逐条判定的项，
     每项带通过/不通过的判例（对照 §3「契约精度 ↔ 门检便宜度」：critic 的意见要能转化成修订动作）
  ② 熔断与退出设计——打回循环的预算给几次？通过的标准是什么（全项通过？N-1 项通过可容忍？）？
     熔断时交付什么（最后一稿+未解决项清单——诚实降级，不装通过）？

金笔记：
  - critic 和 generator 必须是两个隔离窗口——同一窗口自评是「自己批自己的作业」，
    立场污染不可避免（§0 隔离收益在质量维度的应用）
  - 打回的成本是双份的：critic 一发 + generator 重写一发——熔断次数直接乘在账单上（×N 的 N² 棋局）
  - 评审意见的结构化程度决定重写质量：「不够好」→ 重写靠猜；「第 2 条与事实不符，缺数据支撑」→ 修订是执行
  - 与 §4 fan-out 的亲缘：都靠多样性，方向相反——fan-out 用多样本求覆盖，critic 用独立评审求把关
*/
import { spawn, type SpawnResult } from './spawn.ts'

// 熔断预算：为什么是 2——打回一轮的成本 = critic 一发 + 重写一发（思考模式一发 10~100s + 千级 token），
// 两轮改不好大概率不是轮数问题是指令问题；你改这个数之前先算一轮的真实成本
const MAX_REVISIONS = 2

// ---------- TODO ① 你来写：critic 的评审任务书 ----------
// 场景（demo）：审一篇「技术周报」短稿（进料 DEFAULT_DRAFT_BRIEF 定主题，generator 产出初稿）
// 三段式骨架同 §4 归纳任务书，但灵魂在「评审标准」段：
//   - checklist 化：3~5 条可逐项判定的标准（如：事实性——无编造数据；针对性——每句服务主题；实用性——读者能带走动作）
//   - 输出契约必须是结构化的（这是打回循环能机器解析的关键）：
//     通过 → 一行 PASS；不通过 → 逐条列【不通过项 + 原因 + 修订指令】——修订指令要能直接执行
//   - 反面警告：不要写「内容质量高、表达流畅」这类判不了的词（玄学的定义就是判不了）
// ---------- critic 的评审任务书 ----------
// ZCode 优化版（评审问题：④ 三条检查项黏一行没编号——checklist 化的意义就是逐条可判定可引用；
// ⑤ 反面警告照抄骨架注释——那句是给「写标准的人」看的，critic 不写稿读到会困惑；
// ⑥ 契约字面没钉死——「一行结论通过」到底写什么字？解析端要判关键词，契约必须给精确字面。
// 锚改成首行 PASS / FAIL 英文短锚：天然避开「不通过」包含「通过」的子串陷阱，思考模式遵守率也高。
// 保留原版亮点：「修订指令不要直接执行，只给方向」——防 critic 越俎代庖替 generator 改稿）
export function criticPrompt(): string {
	/* ---------- 你写的（原版——保留对照） ----------
	return [
		'角色：你是一个评审专家，任务是评审agent的产出是否符合要求，最终给出结论。',
		'检查项：agent是否是依据事实输出的结果，不要编造数据。' +
		'agent结论要跟要求相关，不要跑题了。'+
		'agent结论是否实用，没实际用处的话不要。',
		'输出契约：检查通过返回一行结论通过；检查不通过时，先返回一行结论检查不通过，然后逐行列出 不通过项、原因、修订方向。修订指令不要直接执行，只给结论即可，你的产出是agent干活的方向指示',
		'反面警告：不要写「内容质量高、表达流畅」这类判不了的词（玄学的定义就是判不了）'
	].join('\n')
	---------- 优化版 ---------- */
	return [
		'角色：你是评审员。上游交接物里有两样东西：原始素材和待审稿件。你只评审、不代改；你没有任何工具，也不要尝试读文件、执行命令或调用任何东西——判断所需的一切已在交接物里。',
		'评审标准（逐条判定，只列不通过的）：',
		'1. 事实性：稿件中每个事实（数字、进展、计划）必须能在交接物的原始素材里找到依据，编造即不通过——对照交接物核对即可，不需要也不应该找外部信息。',
		'2. 针对性：每一句都要服务「团队新人快速了解本周」，跑题句即不通过。',
		'3. 实用性：读者要能带走具体信息（做了什么/接下来关注什么），空泛套话即不通过。',
		// 探针临时条款（严判/熔断）已摘——4 数字性、5 字数矛盾的标准只存在于探针记录里，静止态保持三条
		'输出契约（字面钉死，解析端按此判定）：全部通过 → 首行只写 PASS，不要输出其他任何内容；' +
			'有不通过项 → 首行只写 FAIL，随后每行一条：编号 | 不通过项 | 原因 | 修订指令。',
		'修订指令只给方向不代改稿——你的产出是下一轮重写的方向指示，不是改好的稿子。',
	].join('\n')
}

// ---------- TODO ② 你来写：退出判定 ----------
// 输入：critic 的结论。输出：{ passed: boolean; issues: string[] }——passed=true 立即收工，
// false 时 issues 数组喂给 generator 做修订指令（每条就是一份可执行的修订动作）
// 判定逻辑很便宜（critic 已经按契约输出了），你的活是设计「什么算通过」：
//   PASS 一行 → passed=true；结构化意见 → passed=false + 解析出条目
//   想清楚：解析失败（critic 没按契约说话）算通过还是不通过？——对照 §1「假结论」的教训想
export interface CriticVerdict {
	passed: boolean
	issues: string[]
}
export function parseCriticVerdict(criticConclusion: string): CriticVerdict {
	/* ---------- 你写的（原版——保留对照） ----------
	评审问题：① items.length===1 判通过是形状判定——critic 把意见写成一行（没换行）就误判通过，
	   坏稿放行 critic 白花钱；若改判内容 includes('通过') 则踩「不通过」包含「通过」的子串陷阱——
	   契约的字面与解析的判定必须锚同一个东西，最稳是首行 PASS/FAIL 英文短锚
	② 空输入走 else → passed:false + issues:[]——打回但零修订指令，generator 收到「逐条修订：」空列表盲改
	   （骨架设计题的答案：fail-closed + 把违约本身变成诊断 issue，不要静默空转）
	③ slice(1) 吞首行——契约没钉死首行必是总结行，第一条意见可能就在首行
	const items = criticConclusion.split('\n').filter(item => item.trim())
	let passed = false,
	issues: string[] = []
	if (items.length === 1) {
		passed = true
	} else {
		issues = items.slice(1)
	}
	return { passed, issues }
	---------- 优化版 ---------- */
	const lines = criticConclusion.split('\n').filter((l) => l.trim())
	const first = (lines[0] ?? '').trim().toUpperCase()
	// 首行锚定：PASS 精确匹配（防「PASS 但还有下文」的半通过）；FAIL 同理
	if (first === 'PASS' && lines.length === 1) return { passed: true, issues: [] }
	if (first === 'FAIL') return { passed: false, issues: lines.slice(1) }
	// 同义锚收编（§7 实测错杀后加）：critic 实质批准但写中文「通过」——fail-closed 把批准拒收成熔断。
	// 精确匹配收编是安全的：「不通过」≠「通过」（整串比较，子串陷阱不存在）；宽容度对称于模型实际分布，
	// 歧义仍然不收（「检查不通过」「大致通过」这类不整串等于锚的，照走违约分支）
	if (first === '通过' && lines.length === 1) return { passed: true, issues: [] }
	if (first === '不通过') return { passed: false, issues: lines.slice(1) }
	// 解析失败（空输入 / 首行既非 PASS 也非 FAIL / PASS 后拖了别的话）：fail-closed——
	// 不放行（坏稿代价 > 一轮重跑），把违约本身合成诊断 issue 喂下去，别让 generator 盲改
	return {
		passed: false,
		issues: [`[评审契约违约] critic 输出未按「首行 PASS/FAIL」契约，原文头 80 字：${criticConclusion.slice(0, 80)}——请评审方严格遵守输出契约后重评`],
	}
}

// demo 进料：generator 的初稿任务书（骨架已给——你的 TODO ①② 落在 critic 侧）
const DRAFT_TASK = [
	'任务：基于上游交接物中的素材，写一段给团队新人看的技术周报摘要。',
	'输出契约：一个自然段，120 字以内；包含一条本周进展 + 一条下周关注；不要列表格式。',
].join('\n')
const DRAFT_MATERIAL = '本周素材：完成了会话持久化的原子写入改造（临时文件+重命名，防半截文件）；发现网络沙箱的「禁网」是路径正则的副产品且不一致（npm 可达而 curl 被拦）；下周计划补专用 fetch_url 工具与域名白名单。'

// 生成-评审循环：generator 出稿 → critic 按 checklist 评审 → 不过 → 修订指令喂回重写 → 熔断交付最后一稿+未解决项
export interface CriticLoopResult {
	rounds: number // 实际评审轮数（1 = 初稿即过）
	passed: boolean // 是否通过（false = 熔断，诚实降级交付）
	finalDraft: string // 最后一稿
	issues: string[] // 未解决项（passed=true 时为空）
	history: { draft: string; critic: SpawnResult; verdict: CriticVerdict }[] // 每轮的稿/评审/判定——流转图素材
	promptTokens: number
	completionTokens: number
}

export async function runGeneratorCritic(): Promise<CriticLoopResult> {
	const history: CriticLoopResult['history'] = []
	let handoff = DRAFT_MATERIAL
	let draft = ''
	// 首稿：素材 → generator（工具面清零：写手是纯文本活，挂着 search_notes 只会钓走注意力和 token——§5「工具面=能力面」的实操；
	// thinking 关闭：写 120 字摘要是浅任务，思考 token 是白烧的墙钟；短命 agent 不跑会话结束钩子）
	let first = await spawn(DRAFT_TASK, { handoff, tools: [], thinking: false, skipSessionEndHooks: true })
	history.push({ draft: first.conclusion, critic: first, verdict: { passed: false, issues: [] } }) // 占位——首轮循环里会被真评审覆盖
	let promptTokens = first.promptTokens
	let completionTokens = first.completionTokens
	let rounds = 0
	let passed = false
	let issues: string[] = []
	while (rounds <= MAX_REVISIONS) {
		rounds++
		draft = history[history.length - 1].draft
		// critic：独立窗口评审当前稿。handoff 必须带原始素材——事实性判据要对照物（第一版只给稿件，
		// critic 没见过素材判不了「有无依据」，自己去找：type note.md / 正文里写 run_shell JSON——
		// agentic 先验从文本泄漏 + 契约三连违约熔断，2026-10-23 探针实录）。隔离的边界不变：
		// critic 看素材+稿，仍看不到 generator 的过程
		const critic = await spawn(criticPrompt(), { handoff: `原始素材：${DRAFT_MATERIAL}\n\n待审稿件：${draft}`, tools: [], thinking: false, skipSessionEndHooks: true })
		promptTokens += critic.promptTokens
		completionTokens += critic.completionTokens
		const verdict = parseCriticVerdict(critic.conclusion)
		history[history.length - 1] = { draft, critic, verdict }
		if (verdict.passed) {
			passed = true
			issues = []
			break
		}
		issues = verdict.issues
		if (rounds > MAX_REVISIONS) break // 熔断：评审预算耗尽，带着未解决项降级交付
		// 重写：修订指令 + 原稿 + 原素材，喂回 generator（批评被消费，不是被记录）
		const revise = await spawn(
			[DRAFT_TASK, `上一稿被评审打回，逐条修订：\n${issues.map((s, i) => `${i + 1}. ${s}`).join('\n')}`].join('\n\n'),
			{ handoff: `原始素材：${DRAFT_MATERIAL}\n上一稿：${draft}`, tools: [], thinking: false, skipSessionEndHooks: true },
		)
		promptTokens += revise.promptTokens
		completionTokens += revise.completionTokens
		history.push({ draft: revise.conclusion, critic: revise, verdict: { passed: false, issues: [] } })
	}
	return { rounds, passed, finalDraft: draft, issues, history, promptTokens, completionTokens }
}

export function printCriticResult(r: CriticLoopResult) {
	console.log('\n===== generator-critic 账单 =====')
	for (const [i, h] of r.history.entries()) {
		console.log(`  第${i + 1}稿 → critic [${h.verdict.passed ? '通过' : `打回（${h.verdict.issues.length} 项）`}]: ${h.critic.conclusion.slice(0, 50)}`)
	}
	console.log(`结果：${r.passed ? `通过（${r.rounds} 轮评审）` : `熔断（${r.rounds} 轮评审后仍有 ${r.issues.length} 项未解决——诚实降级交付）`}`)
	console.log(`真账：prompt ${r.promptTokens} / completion ${r.completionTokens}`)
	console.log(`\n=== 最终稿 ===\n${r.finalDraft}`)
	if (!r.passed && r.issues.length) console.log(`\n未解决项：\n${r.issues.map((s, i) => `${i + 1}. ${s}`).join('\n')}`)
}

// 冒烟口（花 GLM 配额；TODO ①② 未填时 criticPrompt 空 + parseCriticVerdict 恒不通过 → 必熔断路径，先验骨架别真跑）：
//   node 10-multi-agent/critic.ts
//   期望：1~2 轮内通过（初稿短任务 critic 通常一轮过）；账单看「每轮双发」的成本结构
//   严判探针：criticPrompt 的标准临时加严（如「必须包含具体数字至少 2 处」——素材里有 120/2 等可数）→ 看打回-修订-复审全循环
//   熔断探针：标准写成矛盾（「字数必须 ≤100 且 ≥150」）→ 看熔断交付：最后一稿 + 未解决项清单，不装通过
const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href
if (isMain) {
	console.log(`\n【generator-critic demo】周报摘要的生成-评审循环\n`)
	const result = await runGeneratorCritic()
	printCriticResult(result)
}
