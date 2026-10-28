// 模块 12 毕业项目 v2 探针：零 token 零外部副作用（§2 同款纪律——不烧 LLM、不真发微信、不碰真数据）
//
// 块 1 覆盖（P1~P6，后续块同步长 P7~P9，见 DESIGN.md §6）：
//   P1 注册+登录行为链：有效邀请码注册 → 正确密码登录发 token → 错密码拒绝
//   P2 注册门禁四态：重码拒绝 / 用户名重复 / 弱密码 / 坏用户名
//   P3 session 生命周期：token 取回用户 / logout 失效 / 过期 token 拒绝
//   P4 SSRF 四拒：127.0.0.1 / 192.168 内网 / [::1] / file: 协议——rss 是唯一用户控 URL 的入口
//   P5 RSS2+Atom 双形状解析：CDATA 标题、Atom link 数组取 alternate href
//   P6 抓取缓存：同 (type,query) 共享同一 Promise；失败不缓存（可重试）
// 跑法：node 12-capstone/daily-brief-v2/probe.ts
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { SOURCES, fetchSourceCached, parseFeed, type SourceType } from './sources.ts'

let pass = 0
let fail = 0
const check = (name: string, ok: boolean) => {
	console.log(`  ${ok ? '✓' : '✗'} ${name}`)
	ok ? pass++ : fail++
}

// ---------- 用户系统探针：数据目录注入临时目录（V2_DATA_DIR 必须在动态 import 前设置——ESM 静态 import 顺序在模块顶） ----------
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'brief-v2-probe-'))
process.env.V2_DATA_DIR = TMP
const users = await import('./users.ts')

console.log('P1 注册+登录行为链')
const inviteCode = await users.createInvite('probe-bootstrap')
const reg = await users.register('alice', 'correct-horse-battery', inviteCode)
check('有效邀请码注册成功', !!reg.user && reg.user.username === 'alice')
check('第一个注册用户自动 admin', reg.user?.admin === true)
const loginOk = await users.login('alice', 'correct-horse-battery')
check('正确密码登录发 token', typeof loginOk.token === 'string' && loginOk.token.length >= 64)
const loginBad = await users.login('alice', 'wrong-password!')
check('错密码拒绝且不泄露哪项错', loginBad.error === '用户名或密码不对')

console.log('P2 注册门禁四态')
const reUse = await users.register('bob', 'valid-password-123', inviteCode)
check('邀请码重用被拒', reUse.error === '邀请码无效或已被使用')
const code2 = await users.createInvite(reg.user!.id)
const dupName = await users.register('alice', 'valid-password-123', code2)
check('用户名重复被拒', dupName.error === '用户名已被占用')
const weakPass = await users.register('bob', 'short', code2)
check('弱密码被拒（<8 位）', weakPass.error === '密码至少 8 位')
const badName = await users.register('不 合 法', 'valid-password-123', code2)
check('坏用户名被拒（非 [a-zA-Z0-9_-]）', !!badName.error?.includes('用户名'))

console.log('P3 session 生命周期')
const token = loginOk.token!
const me = await users.getSessionUser(token)
check('token 取回本人', me?.username === 'alice')
const expiredTok = 'expired'.padEnd(64, '0')
await fs.writeFile(
	path.join(TMP, 'sessions.json'),
	JSON.stringify({ [expiredTok]: { uid: me!.id, expiresAt: Date.now() - 1 } }),
)
check('过期 token 拒绝', (await users.getSessionUser(expiredTok)) === null)
await users.logout(token)
check('logout 后 token 失效', (await users.getSessionUser(token)) === null)

console.log('P4 SSRF 四拒（rss=用户可填任意 URL 的唯一入口，DESIGN.md 威胁模型）')
const expectSSRFReject = async (url: string, label: string) => {
	try {
		await SOURCES.rss.fetch(url)
		check(`${label} 应拒绝`, false)
	} catch (err: any) {
		check(`${label} 拒绝（${String(err?.message).slice(0, 40)}…）`, /SSRF/.test(String(err?.message)))
	}
}
await expectSSRFReject('http://127.0.0.1:8787/api/invites', '环回 127.0.0.1')
await expectSSRFReject('http://192.168.1.1/admin', '私网 192.168.1.1')
await expectSSRFReject('http://[::1]:8787/', 'IPv6 环回 ::1')
await expectSSRFReject('file:///C:/Users/secrets.env', 'file: 协议')

console.log('P5 RSS2+Atom 双形状解析')
const rssSample = `<?xml version="1.0"?><rss version="2.0"><channel><title>行业周报</title>
<item><title><![CDATA[央行发布新规：<标签>也会出现标题里>]]></title><link>https://example.com/1</link><description>第一条描述</description></item>
<item><title>第二条</title><link>https://example.com/2</link></item>
<item><title>无链接应被过滤</title></item></channel></rss>`
const rssItems = parseFeed(rssSample)
check('RSS2 解析出 2 条（无链接的被滤）', rssItems.length === 2)
check('CDATA 标题剥壳保留内容', rssItems[0].title.includes('央行发布新规'))
const atomSample = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
<entry><title>论文 A</title><link rel="alternate" href="https://arxiv.org/abs/2401.00001"/><summary>摘要</summary></entry>
<entry><title>论文 B</title><link href="https://arxiv.org/abs/2401.00002"/></entry></feed>`
const atomItems = parseFeed(atomSample)
check('Atom 解析出 2 条且取到 link href', atomItems.length === 2 && atomItems[0].url === 'https://arxiv.org/abs/2401.00001')

console.log('P6 抓取缓存（N 人同订一个源只打一次外部 API）')
const p1 = fetchSourceCached('rss' as SourceType, 'http://10.0.0.1/feed')
const p2 = fetchSourceCached('rss' as SourceType, 'http://10.0.0.1/feed')
check('同 (type,query) 共享同一在途 Promise', p1 === p2)
const bothFail = await Promise.allSettled([p1.catch(() => 'fail'), p2.catch(() => 'fail')])
check('私网 URL 该次抓取失败（P4 同款防护在缓存路径生效）', bothFail.every((r) => r.status === 'fulfilled' && r.value === 'fail'))
const p3 = fetchSourceCached('rss' as SourceType, 'http://10.0.0.1/feed')
check('失败已清缓存（新 Promise，可重试）', p3 !== p1)
void p3.catch(() => {}) // 不留 unhandled rejection

// ---------- 产线多租户探针：假 LLM + 假抓取注入，零 token 零外网 ----------
// pipeline 也动态 import（在 V2_DATA_DIR 设置后）：它模块级算 DATA 路径，静态 import 会在 env
// 注入前初始化——同 v1 probe 事故的变体（import 副作用把探针数据写进真目录）
const pipe = await import('./pipeline.ts')

// 假 chat：按 system 分流三角色（researcher 出池内 URL 的精选 / writer 从材料抽主题名成稿 /
// critic 一审过）。每次记账 300 tokens（P8 预算线用）。
// 分流词序教训：writer 的 system「你是日报主编，输入是研究员按主题整理的…」也含「研究员」——
// 先判研究员会把 writer 请求吞进 researcher 分支（首版实录：日报落盘成 researcher 的 JSON 串，
// critic 三断言全挂）。主编/质检员词唯一，先判；researcher 走兜底。
const fakeChat = async (system: string, user: string): Promise<{ text: string; promptTokens: number; completionTokens: number; elapsedMs: number }> => {
	const base = { promptTokens: 100, completionTokens: 200, elapsedMs: 5 }
	if (system.includes('主编')) {
		const topicName = /## (.+)/.exec(user)?.[1] ?? '板块' // 材料第一行就是「## 主题名」
		return { ...base, text: `# 情报日报\n\n## ${topicName}\n\n总评：主题总评\n\n- [Raw 1](https://example.com/1) 译1：评1\n- [Raw 2](https://example.com/2) 译2：评2\n\n## 今日总评\n\n${'跨主题串一遍今天最重要的事。'.repeat(60)}` }
	}
	if (system.includes('质检员')) return { ...base, text: JSON.stringify({ score: 9, issues: [], pass: true }) }
	return { ...base, text: JSON.stringify({ items: [
		{ title: 'Raw 1', title_zh: '译1', comment: '评1', url: 'https://example.com/1' },
		{ title: 'Raw 2', title_zh: '译2', comment: '评2', url: 'https://example.com/2' },
	], digest: '主题总评' }) }
}
const fakeFetch = async () => ({
	items: [1, 2, 3].map((i) => ({ title: `Raw ${i}`, url: `https://example.com/${i}`, source: 'rss', meta: `m${i}` })),
	errors: [],
})
const todayStr = new Date().toISOString().slice(0, 10)
const writeSubs = async (uid: string, audience: string, topicName: string) =>
	fs.writeFile(
		path.join(TMP, 'users', uid, 'subscriptions.json'),
		JSON.stringify({ audience, topics: [{ id: 't1', name: topicName, focus: 'f', sources: [{ type: 'rss', query: 'https://example.com/feed' }] }] }),
		'utf8'
	)
const reportsOfProbe = (uid: string) => path.join(TMP, 'reports', uid)

console.log('P7 多租户落盘隔离（runUser 闭包=每人独立 ledger/audience/目录；URL⊆原始池断言在假数据上回归）')
process.env.DAILY_BUDGET_TOKENS = '99999999' // P7 不触熔断（显式设大——防 .env 配小值影响探针）
const inv3 = await users.createInvite('probe')
const [aliceP, bobP, ericP] = await Promise.all([
	users.register('alice7', 'password-777', inv3),
	(async () => { const c = await users.createInvite('probe'); return users.register('bob7', 'password-777', c) })(),
	(async () => { const c = await users.createInvite('probe'); return users.register('eric7', 'password-777', c) })(),
])
await writeSubs(aliceP.user!.id, '转型 AI 工程师的前端开发者', 'AI Agent 工程')
await writeSubs(bobP.user!.id, '医疗行业从业者', '医疗政策')
// eric 不写订阅——register 起步值 {topics:[]}，走「无订阅 skip」分支
const r7 = await pipe.runPipeline([aliceP.user!, bobP.user!, ericP.user!], { chat: fakeChat as any, fetchSources: fakeFetch as any })
check('alice/bob 完成、eric 无订阅被跳过', r7.done.length === 2 && r7.done.includes('alice7') && r7.skipped.some((s) => s.username === 'eric7' && s.reason === '无订阅主题'))
const aMd = await fs.readFile(path.join(reportsOfProbe(aliceP.user!.id), `${todayStr}.md`), 'utf8').catch(() => null)
check('alice 日报落盘', !!aMd && aMd.includes('AI Agent 工程'))
const aSt = JSON.parse(await fs.readFile(path.join(reportsOfProbe(aliceP.user!.id), `status-${todayStr}.json`), 'utf8'))
check('alice status 过审 + ledger 阶段记账（researcher/writer/critic）', aSt.verdict.pass === true && !!aSt.ledger['researcher:t1'] && !!aSt.ledger.writer && !!aSt.ledger.critic)
const aH = JSON.parse(await fs.readFile(path.join(reportsOfProbe(aliceP.user!.id), 'history.json'), 'utf8'))
check('alice history 1 run 3 调用（totals 数学）', aH.runs.length === 1 && aH.totals.calls === 3)
const bMd = await fs.readFile(path.join(reportsOfProbe(bobP.user!.id), `${todayStr}.md`), 'utf8').catch(() => null)
check('bob 日报独立落盘（audience 注入了医疗人设）', !!bMd && bMd.includes('医疗政策'))
const ericSt = JSON.parse(await fs.readFile(path.join(reportsOfProbe(ericP.user!.id), `status-${todayStr}.json`), 'utf8'))
check('eric 落 skipped status 且无假日报', ericSt.skipped === '无订阅主题' && (await fs.readFile(path.join(reportsOfProbe(ericP.user!.id), `${todayStr}.md`), 'utf8').catch(() => null)) === null)

console.log('P8 全局日预算熔断（budget-日期.json 跨用户累计；假 chat 每次 300 tokens）')
await fs.rm(path.join(TMP, `budget-${todayStr}.json`), { force: true }) // P7 的记账清零，预算线从干净起步
process.env.DAILY_BUDGET_TOKENS = '900' // carol 一轮=researcher+writer+critic=3 调用×300=900：跑满触线
const [carolP, daveP] = await Promise.all([
	(async () => { const c = await users.createInvite('probe'); const u = await users.register('carol7', 'password-777', c); await writeSubs(u.user!.id, '读者', '板块'); return u })(),
	(async () => { const c = await users.createInvite('probe'); return users.register('dave7', 'password-777', c) })(),
])
await writeSubs(daveP.user!.id, '读者', '板块2')
const r8 = await pipe.runPipeline([carolP.user!, daveP.user!], { chat: fakeChat as any, fetchSources: fakeFetch as any })
check('carol 跑满完成', r8.done.includes('carol7'))
check('dave 因预算熔断被跳过', r8.skipped.some((s) => s.username === 'dave7' && s.reason.includes('预算')))
const budget = JSON.parse(await fs.readFile(path.join(TMP, `budget-${todayStr}.json`), 'utf8'))
check('全局台账 carol 3 调用 900 tokens（跨用户累计正确）', budget.calls === 3 && budget.promptTokens + budget.completionTokens === 900)
const daveSt = JSON.parse(await fs.readFile(path.join(reportsOfProbe(daveP.user!.id), `status-${todayStr}.json`), 'utf8'))
check('dave 落 skipped status 且无日报', daveSt.skipped.includes('预算') && (await fs.readFile(path.join(reportsOfProbe(daveP.user!.id), `${todayStr}.md`), 'utf8').catch(() => null)) === null)
const carolMd = await fs.readFile(path.join(reportsOfProbe(carolP.user!.id), `${todayStr}.md`), 'utf8').catch(() => null)
check('carol 日报正常落盘（跑满的钱不白花）', !!carolMd)

await fs.rm(TMP, { recursive: true, force: true }) // 清场：探针目录全删，可重复跑
console.log(`\n探针结果: ${pass}/${pass + fail} ${fail === 0 ? '✓ 全过' : '✗ 有失败——看上面归因'}`)
if (fail > 0) process.exitCode = 1

await fs.rm(TMP, { recursive: true, force: true }) // 清场：探针目录全删，可重复跑
