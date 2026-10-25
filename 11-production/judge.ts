/*
模块 11 §2：LLM-as-judge——判据的语义层（骨架——学习核心你来填）

§1 免费性质判「机器判得了的形状」（数字有出处/周报形状/短路定位）——判据锚契约、零成本。
§2 判「机器判不了的语义」：这周报**好不好**（主线/实用/针对性）——免费性质摸不到，要 LLM 当 judge。

judge 就是 §6/§7 的 critic 换岗位——模块 10 的教训直接带岗：
  判据锚【任务书契约】不锚模型输出（抄某次输出当黄金标准=循环论证，§1 已立）
  判据需要什么交接物就给什么——judge 看 finalReport，要核对就得给素材，别让它空对空
  锚钉死 + fail-closed——首行 PASS/FAIL 短锚（§10 教训：同义锚收编、「不通过」含「通过」子串陷阱）

偏差三连（本节核心，judge 的缺陷不是「它可能判错」，是它有系统性偏差）：
  ① 位置偏差：先看的打分高——控制法：乱序/成对比较，别让「第一个重写版」白捡分
  ② 自我偏好：同模型夸同模型——控制法：judge 换模型（和被测不同源）
  ③ 严松漂移：跑十次给分不一致——控制法：抽查人审对账，算一致率，不一致的 case 就是 judge 的药

一次运行、两层判（§1 的 CaseReport.result 存的就是 CompositeResult）：
  产线跑一次（花一次钱）→ 免费性质先判（零成本，跑分器已上岗）→ judge 后判（复用同一份 result，不重跑产线）

本节 TODO：
  ① judgeCriterion——语义判据上岗：锚 REPORT_TASK 里免费性质判不了的部分（一个自然段... 含本周最重要进展与下周方向——「最重要/下周方向」就是语义，数字可溯判不了），写 judgePrompt + 契约
  ② reconcile——对账一次：judge 判 vs 你人判，算一致率；不一致的 case 逐条看，它是 judge 的药
*/
import { spawn } from '../10-multi-agent/spawn.ts'
import type { CompositeResult } from '../10-multi-agent/composite.ts'
import type { CheckResult } from './evals.ts'

// ---------- judge 判据接口（和 §1 Property 同族，区别只在 judge 是异步 LLM 调用） ----------
// 挂点思想不换：判据锚契约，不锚输出。§1 的 Property.check 同步纯函数；judge 要异步——分开定义，
// runEvalSet 免费先跑、judge 后跑，一次产线运行两层判（§1 CaseReport.result 就是给这儿复用的）
export interface JudgeCriterion {
	name: string // 判据名——锚到契约条款（和 §1 same discipline）
	judge: (r: CompositeResult) => Promise<CheckResult>
}

// judge 任务书——judge 是 LLM，判据写清楚「看什么、以什么为锚、怎么输出」
// TODO ① 你来填：锚 REPORT_TASK 的语义部分，写 judgePrompt。三个坑提前标（都来自模块 10 实测）：
//   - 契约给精确字面（首行 PASS/FAIL 短锚——同义锚收编、子串陷阱全是真踩过的坑）
//   - 判据锚契约不锚「某次跑得好的输出」——那不叫标准，叫那一天
//   - judge 只评审不代改，judge 的产出是打回方向不是改好的稿
export function judgePrompt(): string {
	return [
		'角色：你是周报审校员。上游交接物里是团队的周报。你按合同审质量归档：只评审、不代改，判断所需的一切在交接物里。',
		'评审标准（逐条判定，只列不通过的）：',
		'1. 主线：是否说清了本周最重要的 1 项进展（不是平铺罗列）——没有明显主线即不通过。',
		'2. 方向：是否交代了明确的下一步方向——没有下周方向即不通过。',
		'3. 读者：给团队新人看是否真能带走具体信息（做了什么/接下来关注什么）——空泛套话即不通过。',
		// TODO ① 你写 judgePrompt——上面三条是我打的样（锚 REPORT_TASK 语义层），你要审它们对不对再定自己那版。
		// 输出契约（字面钉死）：全部通过 → 首行只写 PASS；有不通过项 → 首行 FAIL，随后每行一个「编号 | 不通过项 | 原因」。
		'输出契约（字面钉死，解析端按此判定）：全部通过 → 首行只写 PASS，不要输出其他任何内容；有不通过项 → 首行只写 FAIL，随后每行一条：编号 | 不通过项 | 原因。',
	].join('\n')
}

// 判 judge 结论：首行 PASS/FAIL 短锚（§10 fail-closed 教训——解析失败算不通过，不静默放行）
// 骨架已给，你审一遍：judge 乱说话（不是 PASS/FAIL 开头）该算通过还是不通过？——§10 的答案：fail-closed
export function parseJudgeVerdict(conclusion: string): { passed: boolean; issues: string[] } {
	const lines = conclusion.split('\n').filter((l) => l.trim())
	const first = (lines[0] ?? '').trim().toUpperCase()
	if (first === 'PASS') return { passed: true, issues: [] }
	if (first.startsWith('FAIL')) {
		return { passed: false, issues: lines.slice(1).map((l) => l.trim()).filter(Boolean).slice(0, 8) }
	}
	// fail-closed：judge 没按契约说话——不算通过（放行一个烂 judge = 分数造假），把违约本身变成诊断
	return { passed: false, issues: [`judge 未按契约输出（首行非 PASS/FAIL）：${conclusion.slice(0, 40)}`] }
}

// ---------- judge 跑分器：复用 §1 的产线运行结果，两层判分开跑 ----------
// 一次 runCompositeSystem 只花一次钱，免费性质 + judge 各判一次（§1 CaseReport.result 就是给 judge 复用的挂点）
export async function runJudges(result: CompositeResult, criteria: JudgeCriterion[]): Promise<CheckResult[]> {
	const out: CheckResult[] = []
	for (const c of criteria) {
		try {
			out.push(await c.judge(result))
		} catch (e) {
			// fail-closed：judge 调用崩了算不通过，不静默跳过
			out.push({ status: 'fail', note: `judge 调用失败：${(e as Error).message.slice(0, 60)}` })
		}
	}
	return out
}

// ---------- 对账：judge 判 vs 人判，算一致率 ----------
// TODO ② 你来写 reconcile——judge 的药从这找：一致率 100% 说明判据被摸透了（Goodhart），
// 不一致的 case 逐条看，那是 judge 和人类标准第一次分裂的地方。骨架先给接口和注释，逻辑你填。
export function reconcile(judgeVerdicts: { caseId: string; judgePassed: boolean }[], humanVerdicts: { caseId: string; humanPassed: boolean }[]): { rate: number; mismatches: string[] } {
	// TODO ② 你来写：rate = 一致数 / 总数；mismatches = caseId 列表（judge 和人判不一样的）
	// 想清楚：一致率不是越高越好——考的都是「屁话周报」，judge 全放行人也全放行=一致率 100% 但是废的
	// 对账是对「判据本身」对账，不是对「跑分」对账——judge 从严从宽都要人校对才坐实
	throw new Error('TODO ② reconcile 未实现')
}

// 冒烟口（花 GLM 配额：judge 一次 = 一次 spawn；§2 骨架没真实号源可判，先留 import 冒烟）：
//   node 11-production/judge.ts
const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href
if (isMain) {
	console.log('【judge §2】import 冒烟——judge 判据/TODO 填完后再跑真实对账')
	console.log('judgePrompt 判据数：', judgePrompt().split('\n').length + ' 行（含契约）')
	const sample = '产线在【研究段】熔断：简报 2 轮修订仍未过审——写作段未启动'
	console.log('fail-closed 探针：', JSON.stringify(parseJudgeVerdict('我不是PASS也不是FAIL，我写了段话')))
}