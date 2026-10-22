/*
模块 10 §3 配套：门检纯函数的单元测试——仓库第一份正式单测

为什么门检配得上单测（而 agentLoop 不配）：
  - 「便宜且确定」判据的另一面就是纯函数：可离线穷举边界，一分 GLM 配额不花
  - 门检是流水线的裁判，裁判判错两头都是钱：冤枉打回 = 全段重跑、漏放 = 瑕疵下游硬吃
  - 分工：纯函数用单测（零配额换边界覆盖），agent 整体行为用实测探针（花配额换真行为）
    ——测试工具按测试对象的性质选，不是什么都上单测

测试里四发「回归锁」：对着评审出的原版 bug 写——① >max 理由复制成「少于」③「第0条」
② 尾换行冤枉打回，外加「空结论」缺口（写测试时逼出来的：check1 拦得住空、check2 拦不住）。
回归锁的纪律：每修一个 bug，留一条「它再犯就红」的测试——防线接没接电，跑一遍就知道

跑法（零配额，import 不会触发 isMain 的付费跑）：
  node --test 10-multi-agent/pipeline.test.ts
*/
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildDemoChecks } from './pipeline.ts'

const [check1, check2] = buildDemoChecks()

// ---------- check1（提炼段：3~5 条、每条行首 '- '） ----------
test('check1 合规：3 条，中间/结尾空行不计条数', () => {
	assert.equal(check1('- a\n\n- b\n- c\n\n'), null)
})

test('check1 下边界外：2 条打回，理由带实测数与目标区间（方向+实测+修法）', () => {
	const reason = check1('- a\n- b')
	assert.match(reason!, /2 条/)
	assert.match(reason!, /3~5/)
})

test('check1 回归锁①：6 条打回时方向必须正确——理由不得再说「少于」', () => {
	const reason = check1('- 1\n- 2\n- 3\n- 4\n- 5\n- 6')
	assert.match(reason!, /6 条/)
	assert.doesNotMatch(reason!, /少于/) // 原版复制粘贴 bug：超条数也报「少于」
})

test('check1 上边界：恰好 5 条放行', () => {
	assert.equal(check1('- 1\n- 2\n- 3\n- 4\n- 5'), null)
})

test('check1 回归锁③：非行首 - 打回，条数从 1 数——不得出现「第0条」', () => {
	const reason = check1('- a\n1. b\n- c')
	assert.match(reason!, /第 2 条/)
	assert.doesNotMatch(reason!, /第0/)
})

test('check1 空结论：0 条自然落入下边界打回（空手 ≠ 合格，check1 免费得到）', () => {
	assert.match(check1('')!, /0 条/)
})

// ---------- check2（科普段：单个自然段、≤150 字符） ----------
test('check2 回归锁②：尾随换行不算第二段——不冤枉打回', () => {
	assert.equal(check2('一段话。\n'), null)
})

test('check2 双段打回；列表必然多行，被同一判据拦住（巧合防线明示在案）', () => {
	assert.match(check2('第一段\n\n第二段')!, /2 段/)
	assert.match(check2('- a\n- b')!, /2 段/)
})

test('check2 字符边界：恰好 150 放行、151 打回带实测数', () => {
	assert.equal(check2('a'.repeat(150)), null)
	assert.match(check2('a'.repeat(151))!, /151/)
})

test('check2 空结论/全空白打回——空手 ≠ 合格（写测试逼出的缺口，原版放行）', () => {
	assert.match(check2('')!, /为空/)
	assert.match(check2('  \n  ')!, /为空/)
})
