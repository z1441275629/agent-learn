/*
模块 10 §7 v2 配套：digestCheck（研究段形状门检）的单元测试

门检是纯函数——零配额换边界覆盖（§3/critic.test.ts 先例）。四个字面锚各给正反例，
外加一条设计边界：形状全过但内容编造 → 门检必须放行（内容真假是审校① 的活，判据不混层）。
对着 A 版探针的漏网写回归锁：研究员 ok:true 但交乱码/段落 → 门检必须拦下。

跑法：node --test 10-multi-agent/composite.test.ts
*/
import test from 'node:test'
import assert from 'node:assert/strict'
import { digestCheck } from './composite.ts'

const okDigest = [
	'【主线】审校机器上岗：修前熔断 completion 11724 → 修后通过 7557（出处：§6）',
	'隔离实测：主管 prompt 13749，五子合计 92917（出处：§2）',
	'并行墙钟 51.1s，串行和 72.5s（出处：§4）',
	'门检三出路：打回 / 带标注放行 / 失败短路（出处：§3）',
].join('\n')

test('四锚全过的合格简报 → 零违约', () => {
	assert.deepEqual(digestCheck(okDigest, 6), [])
})

test('条数 2 → 条数违约（下界拦截）', () => {
	const v = digestCheck('【主线】一条 7（出处：§1）\n两条 42（出处：§2）', 6)
	assert.equal(v.length, 1)
	assert.match(v[0]!, /条数/)
})

test('条数 6 → 条数违约（上界同样拦——多了也是违约）', () => {
	const six = Array.from({ length: 6 }, (_, i) => `要点 ${i + 1}（出处：§${(i % 6) + 1}）`).join('\n')
	const v = digestCheck(six.replace('要点 1', '【主线】要点 1'), 6)
	assert.equal(v.length, 1)
	assert.match(v[0]!, /条数/)
})

test('首行无【主线】标注 → 违约（契约字面：主线放第一行）', () => {
	const v = digestCheck('普通要点 1（出处：§1）\n要点 2 带 42（出处：§2）\n【主线】要点 3 数字 7（出处：§3）', 6)
	assert.ok(v.some((s) => /主线/.test(s)))
})

test('含数字要点不足 2 条 → 违约', () => {
	const v = digestCheck('【主线】无数字（出处：§1）\n只有一条带 42（出处：§2）\n第三条无数字（出处：§3）', 6)
	assert.ok(v.some((s) => /数字/.test(s)))
})

test('出处编号越界（§9）→ 违约——机器判得到的硬伤：指向不存在的小节', () => {
	const v = digestCheck('【主线】要点 100（出处：§9）\n要点 42（出处：§1）\n要点 7（出处：§2）', 6)
	assert.ok(v.some((s) => /越界/.test(s)))
})

test('设计边界：形状全过但内容编造 → 门检放行——内容真假是审校① 的活，判据不混层', () => {
	// 数字全编、但条数/主线/数字条数/出处编号全合规——门检瞎是设计不是 bug：
	// 门检混进内容判断就成了廉价 critic（§3「两头不占」的门检版）
	const v = digestCheck('【主线】本周营收增长 300%（出处：§1）\n用户 42 万（出处：§2）\n修复 7 个缺陷（出处：§3）', 6)
	assert.deepEqual(v, [])
})

test('回归锁：空输入 → 多锚同时违约，不静默放行（A 版「ok:true 交乱码」漏网的防线）', () => {
	const v = digestCheck('   \n ', 6)
	assert.ok(v.length >= 2)
})
