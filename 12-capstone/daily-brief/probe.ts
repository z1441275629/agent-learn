// 模块 12 毕业项目：落盘层探针（零 token 假数据——§2 同款纪律：不烧 LLM 验证落盘语义）
//
// 验什么（2026-10-28 用户需求：status 带日期不覆盖 + history 跨日总账汇总）：
//   P1 首跑三件套全落盘：YYYY-MM-DD.md / status-YYYY-MM-DD.json / history.json
//   P2 同日重跑语义：日报与 status 覆盖当日份（一天一份最新），history.runs 追加不覆盖（按次记）
//   P3 跨日汇总数学：totals = runs 逐条求和（calls/tokens/墙钟）
//   P4 跨天不覆盖：伪造昨天日期的 status 文件在场时，今天再跑不动它（文件名分家）
//   P5 progress 并发写安全：三路并发 emit 不丢事件（fanout 竞态回归）
//   P6 通知链接解析：BRIEF_PUBLIC_URL 钉死优先 > 自动探测（换热点 IP 漂移跟随）
//   P7 通知 key 解析：单数+复数合并、分隔容忍、去重、空（真发是外部副作用不进探针）
// 跑法：node 12-capstone/daily-brief/probe.ts
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { writeOutputs, emitProgress, parseSendkeys, type TopicResult, type Ledger } from './pipeline.ts'
import { publicURL } from './lan.ts'

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'brief-probe-'))
const date = new Date()
const p = (n: number) => String(n).padStart(2, '0')
const today = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
const yesterday = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate() - 1)}`

let pass = 0
let fail = 0
const check = (name: string, ok: boolean) => {
	console.log(`  ${ok ? '✓' : '✗'} ${name}`)
	ok ? pass++ : fail++
}

const fakeTopic = (id: string, n: number): TopicResult => ({
	topic: { id, name: id, focus: '', hnQuery: '', githubQuery: '' },
	items: Array.from({ length: n }, (_, i) => ({ title: `t${i}`, title_zh: `译${i}`, comment: `评${i}`, url: `https://example.com/${id}/${i}` })),
	digest: `${id} 总评`,
	raw: n * 3,
	errors: [],
})
const fakeLedger = (multiplier: number): Record<string, Ledger> => ({
	'researcher:t1': { calls: multiplier, promptTokens: 100, completionTokens: 50, elapsedMs: 1000 },
	writer: { calls: 1, promptTokens: 200, completionTokens: 300, elapsedMs: 2000 },
})
const verdict = { pass: true, issues: [] as string[], score: 8 }

console.log('P1 首跑三件套落盘')
await writeOutputs(TMP, { markdown: '# 第一版', results: [fakeTopic('t1', 2)], verdict, ledger: fakeLedger(1), startedAt: Date.now() - 5000 })
check(`${today}.md 存在`, await fs.readFile(path.join(TMP, `${today}.md`), 'utf8').then((s) => s === '# 第一版').catch(() => false))
const st1 = await fs.readFile(path.join(TMP, `status-${today}.json`), 'utf8').then((s) => JSON.parse(s)).catch(() => null)
check(`status-${today}.json 存在且带日期字段`, st1?.date === today)
check('history.json 存在且 runs=1', await fs.readFile(path.join(TMP, 'history.json'), 'utf8').then((s) => JSON.parse(s).runs.length === 1).catch(() => false))

console.log('P2 同日重跑：日报/status 覆盖当日，history 追加')
await writeOutputs(TMP, { markdown: '# 第二版', results: [fakeTopic('t1', 3)], verdict, ledger: fakeLedger(2), startedAt: Date.now() - 6000 })
check('日报被当日重跑覆盖为第二版', (await fs.readFile(path.join(TMP, `${today}.md`), 'utf8')) === '# 第二版')
const st2 = JSON.parse(await fs.readFile(path.join(TMP, `status-${today}.json`), 'utf8'))
check('status 被当日重跑覆盖（selected=3 是第二跑的）', st2.topics[0].selected === 3)
const h2 = JSON.parse(await fs.readFile(path.join(TMP, 'history.json'), 'utf8'))
check('history.runs 追加为 2（不覆盖）', h2.runs.length === 2)

console.log('P3 跨日汇总数学：totals = runs 求和')
const sum = (k: string) => h2.runs.reduce((a: number, r: any) => a + r[k], 0)
check(`totals.calls=${h2.totals.calls} = 逐条和 ${sum('calls')}`, h2.totals.calls === sum('calls'))
check(`totals.promptTokens=${h2.totals.promptTokens} = 逐条和 ${sum('promptTokens')}`, h2.totals.promptTokens === sum('promptTokens'))
check(`totals.elapsedMs=${h2.totals.elapsedMs} = 逐条和 ${sum('elapsedMs')}`, h2.totals.elapsedMs === sum('elapsedMs'))
check('totals.runs = runs.length', h2.totals.runs === h2.runs.length)

console.log('P4 跨天不覆盖：昨天的 status 不被今天动')
await fs.writeFile(path.join(TMP, `status-${yesterday}.json`), '{"date":"yesterday"}', 'utf8')
await writeOutputs(TMP, { markdown: '# 第三版', results: [fakeTopic('t1', 1)], verdict, ledger: fakeLedger(1), startedAt: Date.now() })
check(`status-${yesterday}.json 原样（文件名分家）`, (await fs.readFile(path.join(TMP, `status-${yesterday}.json`), 'utf8')) === '{"date":"yesterday"}')
check('history.runs 追加为 3', JSON.parse(await fs.readFile(path.join(TMP, 'history.json'), 'utf8')).runs.length === 3)

console.log('P5 progress 并发写安全（fanout 竞态回归——08 金笔记②）')
await emitProgress(TMP, 'start', '首事件')
// 三路并发 emit：无串行队列时读-改-写竞态互相覆盖（08 金笔记②原坑），串行队列下必须 4 条全落
await Promise.all([emitProgress(TMP, 'researcher', '并发 A'), emitProgress(TMP, 'researcher', '并发 B'), emitProgress(TMP, 'researcher', '并发 C')])
const pEvents = JSON.parse(await fs.readFile(path.join(TMP, `progress-${today}.json`), 'utf8'))
check(`4 个事件全落盘不丢（实际 ${pEvents.length}）`, pEvents.length === 4)
check('事件带 ts/stage/message 三件', pEvents.every((e: any) => e.ts && e.stage && e.message))

console.log('P6 通知链接解析（lan.ts 三态——换热点 IP 漂移自动跟随）')
process.env.BRIEF_PUBLIC_URL = 'http://pinned.example:9999'
check('BRIEF_PUBLIC_URL 钉死时原样生效（逃生门优先）', publicURL() === 'http://pinned.example:9999')
delete process.env.BRIEF_PUBLIC_URL
const auto = publicURL()
// RFC1918 三段（10.x / 172.16-31.x / 192.168.x）——个人热点段不止 192.168（实测 iPhone=172.20.10.x、换热点=10.190.x）
// 前缀段数不齐（10=1段、172.x/192.168=2段），公共后缀统一三段：前缀|段.\d+\.\d+\.\d+
check('缺省自动探测 RFC1918 形状（无网卡/无 RFC1918 = null 合法）', auto === null || /^http:\/\/(10|172\.(1[6-9]|2\d|3[01])|192\.168)\.\d+\.\d+\.\d+:\d+$/.test(auto))

console.log('P7 通知 key 解析（多人推送：SCT_SENDKEYS 数组化——Server酱 无一 key 多推机制，每家人各自注册）')
const pk = parseSendkeys({ SCT_SENDKEY: 'k1 , k2', SCT_SENDKEYS: 'k2 k3,,k4' } as any)
check('单数+复数合并解析出 k1~k4（逗号/空格分隔都吃）', JSON.stringify(pk) === JSON.stringify(['k1', 'k2', 'k3', 'k4']))
check('重复 key 去重（k2 两处只发一次）', pk.filter((k) => k === 'k2').length === 1)
check('全空 = 空数组（no-op 通知层不炸产线）', parseSendkeys({}).length === 0)

await fs.rm(TMP, { recursive: true, force: true }) // 清场：探针目录全删，可重复跑
console.log(`\n探针结果: ${pass}/${pass + fail} ${fail === 0 ? '✓ 全过' : '✗ 有失败——看上面归因'}`)
if (fail > 0) process.exitCode = 1
