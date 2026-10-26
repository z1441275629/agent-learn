/*
模块 10 §9 配套：单 agent 基线——×N 兑换率的分母

对比设计（公平参数钉死——改任何一个，×N 就没有意义）：
  同一份素材（import 自 composite——单一事实源，契约漂移的教训反过来用在数据上）
  同一个交付契约（与产线 REPORT_TASK 的输出契约逐字对齐：一个自然段/150字/主线+下周方向/数字不造）
  同一套窗口配置（tools:[] / thinking:'off' / skipSessionEndHooks:true——与产线六个窗口完全一致）
  唯一的变量：结构——单窗口一发干完「研究+写作」，没有门检、没有审校、没有熔断

基线是什么：裸 agent。它的账单是「不上多 agent」的价格锚点——
产线多付的钱 = ×N 的分子；产线多买到的东西 = §9 TODO ③ 要你列的清单
*/
import { spawn, type SpawnResult } from './spawn.ts'
import { SOURCE_MATERIAL } from './composite.ts'

// 单 agent 任务书：研究+写作合并进一个窗口（产线把它拆成两段+两级闸门）
const BASELINE_TASK = [
	'任务：把上游交接物里的本周原始工作记录，先组织出要点（判断主线、挑最有说服力的数字），再写成一段给团队新人看的技术周报。',
	'输出契约：一个自然段，150 字以内；含本周最重要的 1 项进展与下周方向；数字直接用素材里的，不要自造；不要列表格式。',
].join('\n')

export async function runBaseline(): Promise<SpawnResult> {
	return spawn(BASELINE_TASK, { handoff: `原始素材（模块10 多Agent六节战果）：\n${SOURCE_MATERIAL}`, tools: [], thinking: 'off', skipSessionEndHooks: true })
}

// 冒烟口（花 GLM 配额，一发）：
//   node 10-multi-agent/baseline.ts
//   期望：一段周报 + 一发账单；prompt/completion 填进 TUTORIAL §9 的槽，
//   与产线六窗口的 6578/1539 对比——×N 的 prompt 倍率和 completion 倍率分开算
const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href
if (isMain) {
	console.log(`\n【单 agent 基线】同一素材同一交付契约，一个窗口一发\n`)
	const r = await runBaseline()
	console.log(`结果：${r.ok ? '成稿' : `失败：${r.error}`}`)
	console.log(`基线账单：prompt ${r.promptTokens} / completion ${r.completionTokens}`)
	console.log(`\n=== 基线周报 ===\n${r.conclusion}`)
	console.log(`\n对照：产线 v2 六窗口实测 6578/1539（§8 同次运行）——×N 分别算 prompt 和 completion 的倍率`)
}
