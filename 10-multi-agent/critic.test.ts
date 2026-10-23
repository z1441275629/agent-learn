/*
模块 10 §6 配套：parseCriticVerdict 的单元测试（§3 先例：纯函数用单测，零配额换边界覆盖）

回归锁对着原版两个 bug 写：
  - 「一行=通过」的形状判定（单行意见被误判通过、坏稿放行）
  - 空输入静默空转（打回但零修订指令，generator 盲改）
优化版的锚：首行 PASS/FAIL 精确匹配，其余一切 fail-closed + 诊断 issue

跑法：node --test 10-multi-agent/critic.test.ts
*/
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCriticVerdict } from './critic.ts'

test('PASS 单行 → 通过', () => {
	assert.deepEqual(parseCriticVerdict('PASS'), { passed: true, issues: [] })
})

test('PASS 带尾随空行仍通过（滤空行）', () => {
	assert.deepEqual(parseCriticVerdict('PASS\n\n'), { passed: true, issues: [] })
})

test('PASS 后拖内容 → 契约违约 fail-closed（半通过不是通过）', () => {
	const v = parseCriticVerdict('PASS\n三项全过，无需修改')
	assert.equal(v.passed, false)
	assert.match(v.issues[0]!, /契约/)
})

test('FAIL + 条目 → 打回，条目逐行解析（不吞首行也不吞条目）', () => {
	const v = parseCriticVerdict('FAIL\n1 | 事实性 | 编造了数据 | 删除无素材依据的数字\n2 | 实用性 | 全是套话 | 改写为具体进展')
	assert.equal(v.passed, false)
	assert.equal(v.issues.length, 2)
	assert.match(v.issues[0]!, /事实性/)
})

test('回归锁：单行意见（无 PASS/FAIL 锚）不得误判通过——原版「一行=通过」的坑', () => {
	const v = parseCriticVerdict('1. 事实性不通过：编造了 3 个数据，应删除')
	assert.equal(v.passed, false) // 原版 items.length===1 → passed:true，坏稿放行
})

test('回归锁：中文「检查不通过」首行不放行——子串陷阱防线（「不通过」包含「通过」）', () => {
	const v = parseCriticVerdict('检查不通过\n事实性：编造数据')
	assert.equal(v.passed, false)
})

test('同义锚收编（§7 错杀后加）：中文「通过」整串单行 → 放行——实质批准不再被安全网错杀', () => {
	assert.deepEqual(parseCriticVerdict('通过'), { passed: true, issues: [] })
})

test('「不通过」整串首行 → 打回收条目（与「通过」的区分靠整串比较，不靠子串）', () => {
	const v = parseCriticVerdict('不通过\n1 | 事实性 | 编造 | 删除')
	assert.equal(v.passed, false)
	assert.equal(v.issues.length, 1)
})

test('「大致通过」等含糊措辞不收编——宽容度到同义锚为止，歧义照走违约分支', () => {
	const v = parseCriticVerdict('大致通过，个别地方可改')
	assert.equal(v.passed, false)
	assert.match(v.issues[0]!, /契约/)
})

test('空输入 → 契约违约 fail-closed，不得零修订指令静默空转（原版坑②）', () => {
	const v = parseCriticVerdict('   \n  ')
	assert.equal(v.passed, false)
	assert.ok(v.issues.length > 0, '违约必须带诊断 issue，不许空数组')
	assert.match(v.issues[0]!, /契约/)
})
