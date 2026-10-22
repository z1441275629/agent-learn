/*
模块 10 §4：parallel fan-out/fan-in（并行扇出汇总）——模式三：map-reduce 的 agent 版（骨架——两处学习核心你来填）

模式一句话：同一问题 N 发 spawn 同时上天，墙钟 = max 而非 sum；fan-in 再起一个归纳 agent 收拢。
本节买的不是 token（总量照旧 ×N，账单分文不少），是墙钟——§2 失控探针就是反面教材：
五单互相独立却串行 ~20 分钟（最长单 418s），并行形态下墙钟 ≈ 最长单 + 归纳。

血缘：08 planner 的无依赖子任务 Promise.all（工具层并发 → 任务层并发）；
Anthropic orchestrator-worker 的 worker 扇出 + orchestrator 归纳。

本节两个学习核心（TODO）：
  ① fan-in 归纳任务书——N 份样本怎么合成一份：去重 / 选优 / 分歧标注。
     归纳是链条最后一段，它的输出形状就是整条链的交付形状（§3 契约纪律的延续）
  ② spawnWithDeadline——超时弃子三件套，09 withTimeout（hooks.ts）的任务层重写（同构不同层）：
     race 观察、不取消（JS 没有取消——弃子只是「不再等」，钱照烧）
     .finally 清计时器（输家的 timer 不清就漏）
     迟到补账（真 spawn 落地就 charge——「花掉的钱不因弃子而看不见」）

金笔记：
  - 并行省的是墙钟不是 token——账单里只有耗时列讲真话，printFanOutResult 会把「墙钟 vs 串行和」并排打出来
  - 最慢的决定墙钟：超时预算是「愿意为一发等多久」，不是「一发需要多久」——定值依据要能说出来
  - 失败语义收全尸：挂的/弃的不拖累活的，交接物里无效样本如实标注——归纳 agent 才不会把缺席当内容（空手 ≠ 消息丢失三连）
*/
import { spawn, type SpawnResult } from './spawn.ts'

// 超时弃子预算（.env 可覆盖）。120s 的依据：§3 实测思考模式单发 15~102s，留了 ~20% 余量——
// 你的依据可以不同，但要能说出来（金笔记第二条）
const FANOUT_TIMEOUT_MS = Number(process.env.FANOUT_TIMEOUT_MS) || 120_000

// TODO ② 你来写：09 withTimeout 的任务层重写。签约：入参任务书 + 记账回调 + 可选 handoff；出参 Promise<SpawnResult>
// 三件套对着 09 写（别复制——层变了细节跟着变）：
//   1. race：真 spawn vs 超时合成样本（合成 SpawnResult：ok:false、error: '超时弃子：…'、tokens 0——真账由迟到补记）
//   2. .finally 清计时器
//   3. 真 spawn 的 .then(charge)：无论赢没赢 race，落地就记账；迟到者（race 已输）先打一行病因诊断日志再记
// 一个要想清楚的差异：09 版超时是 reject（钩子失败=异常），这里超时是 resolve 合成样本（弃子不是异常，
// 是「带着缺席信息继续走」的正常流程）——签名跟着从 Promise<T> 抛错 变成 Promise<SpawnResult> 不抛
export function spawnWithDeadline(
	task: string,
	charge: (r: SpawnResult) => void,
	opts?: { handoff?: string },
): Promise<SpawnResult> {
	// TODO ② 你来填（占位返回——填完前 fan-out 零消耗；但 fan-in 是真 spawn 照跑，isMain 仍要花一发的钱）
	void task
	void charge
	void opts
	return Promise.resolve({
		ok: false,
		conclusion: '（占位——spawnWithDeadline 未实现）',
		promptTokens: 0,
		completionTokens: 0,
		elapsedMs: 0,
		error: 'spawnWithDeadline 未实现',
	})
}

// TODO ① 你来写：fan-in 归纳任务书（demo 默认值）
// 场景：同题三样本（DEFAULT_QUESTION），交接物是三份编号结论（带 有效/无效 标注）
// 要点：归纳 ≠ 拼接——去重（三份说的是同一件事）/ 选优（哪份表述最清楚）/ 分分歧标注（样本间矛盾要指出，不要悄悄选边）
// 契约钉形状：输出几段、多长、要不要说明取舍依据——§3 的「契约精度 ↔ 门检便宜度」在最后一段同样成立
export const DEFAULT_FANIN_TASK = '【TODO ① 你来写：收到什么 / 怎么合（去重选优分歧标注）/ 交付什么形状】'

// demo 进料：开放解释题——同题多样本才有「归纳」可做（封闭题三份答案一字不差，fan-in 白花钱）
const DEFAULT_QUESTION = '用三句话给编程新手解释：什么是 token（模型计费与上下文的计量单位）'

export interface FanOutResult {
	samples: SpawnResult[] // race 裁定后的 N 份（含超时弃子的合成样本——tokens 0，账在 ledger）
	fanIn: SpawnResult // 归纳 agent
	wallMs: number // 全程墙钟（fan-out 并行段 + fan-in）
	serialSumMs: number // 对照组：各样本耗时之和 + fan-in——「若串行要多久」
	ledger: SpawnResult[] // 真账：真 spawn 落地才记（fanIn 也入账）；迟到者在打印时可能还没落地，打印函数会如实标注
}

export async function runFanOutFanIn(question: string, opts: { n?: number; fanInTask?: string } = {}): Promise<FanOutResult> {
	const t0 = Date.now()
	const n = opts.n ?? 3
	const ledger: SpawnResult[] = []
	const charge = (r: SpawnResult) => ledger.push(r)
	// fan-out：map 出 N 个 promise 一起 await——这是「并行」的全部语法；for-await 逐发就是 §2 的串行老路
	const samples = await Promise.all(Array.from({ length: n }, () => spawnWithDeadline(question, charge)))
	// 交接物拼接：编号 + 有效/无效标注——无效样本的「缺席」是归纳的信息，不是垃圾（挂的写原因，弃的写超时）
	const handoff = samples
		.map((r, i) => `【样本${i + 1}｜${r.ok ? '有效' : `无效（${r.error ?? '未知原因'}）`}】${r.conclusion}`)
		.join('\n\n')
	// fan-in：串行收尾——它要等全部样本到齐，天然串行（想想：为什么 fan-in 没法并行？）
	const fanIn = await spawn(opts.fanInTask ?? DEFAULT_FANIN_TASK, { handoff })
	ledger.push(fanIn)
	const serialSumMs = samples.reduce((s, r) => s + r.elapsedMs, 0) + fanIn.elapsedMs
	return { samples, fanIn, wallMs: Date.now() - t0, serialSumMs, ledger }
}

export function printFanOutResult(result: FanOutResult) {
	console.log('\n===== fan-out/fan-in 账单 =====')
	for (const [i, s] of result.samples.entries()) {
		console.log(
			`  样本${i + 1} [${s.ok ? '有效' : `弃/败：${s.error ?? ''}`}] prompt ${s.promptTokens} / completion ${s.completionTokens} (${s.elapsedMs}ms)：${s.conclusion.slice(0, 30)}`,
		)
	}
	const landed = result.ledger.length
	const promptTokens = result.ledger.reduce((s, r) => s + r.promptTokens, 0)
	const completionTokens = result.ledger.reduce((s, r) => s + r.completionTokens, 0)
	const expected = result.samples.length + 1
	// 落地数 < 应记数 = 有迟到者还没进账——照实打出来，不装全
	console.log(`真账（落地即记）：prompt ${promptTokens} / completion ${completionTokens}（落地 ${landed}/${expected} 发${landed < expected ? '——迟到者未进账，实际更高' : ''}）`)
	const saved = Math.max(result.serialSumMs - result.wallMs, 0)
	console.log(`墙钟 ${(result.wallMs / 1000).toFixed(1)}s vs 串行和 ${(result.serialSumMs / 1000).toFixed(1)}s（省 ${saved > 0 ? (saved / 1000).toFixed(1) + 's' : '0——并行为零或负'}）`)
	console.log(`\n=== fan-in 归纳 ===\n${result.fanIn.conclusion}`)
}

// 冒烟口（花 GLM 配额；TODO ② 填完前 fan-out 走占位样本、fan-in 仍真跑一发——管线验证只花一发钱）：
//   node 10-multi-agent/fanout.ts
//   期望：三发并行（样本耗时重叠）、fan-in 收拢一份、墙钟 < 串行和
//   省钱小跑：先 n=2 验管线（改 isMain 里的 n），再放开 3
//   弃子探针：FANOUT_TIMEOUT_MS=15000 node 10-multi-agent/fanout.ts ——慢样本被弃（占位仍 0 秒返回），
//     看交接物里「无效（超时弃子…）」标注 + fan-in 如何处理缺席；迟到者日志与补账看真账行
const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href
if (isMain) {
	console.log(`\n【fan-out 问题】${DEFAULT_QUESTION}\n`)
	const result = await runFanOutFanIn(DEFAULT_QUESTION)
	printFanOutResult(result)
}
