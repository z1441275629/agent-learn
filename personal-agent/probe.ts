// 个人 Agent 工作台 · 模块 13 探针：零 token（OCR 全本地，不调任何 LLM）
// 跑法：node personal-agent/probe.ts
import fs from 'node:fs/promises'
import path from 'node:path'
import { recognize, normalizeCjk, terminateOcr } from './ocr.ts'
import { needsTranslation } from './translate.ts'

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
	console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail ? `（${detail}）` : ''}`)
	ok ? pass++ : fail++
}

console.log('Q1 中文空格归一（中文 OCR 输出「发 票 金 额」→「发票金额」）')
check('汉字间空格被合并', normalizeCjk('发 票 金 额 : 1,280.50') === '发票金额 : 1,280.50')
check('中英之间空格保留', normalizeCjk('Hello 世界') === 'Hello 世界')
check('纯英文不受影响', normalizeCjk('Hello Agent Lab') === 'Hello Agent Lab')

console.log('Q2 翻译判定（只翻非中文行——中文再翻既费钱又改坏专名）')
check('英文行需要翻译', needsTranslation('Hello Agent Lab'))
check('中文行不翻', needsTranslation('发票金额：1,280.50') === false)
check('纯数字/符号不翻', needsTranslation('1,280.50 %') === false)
check('中英混排但以中文为主不翻', needsTranslation('API 限流说明') === false)
check('日文行需要翻译（非 CJK 统一区）', needsTranslation('こんにちは世界'))

console.log('Q3 真图 OCR（fixtures/ocr-sample.png：三行中英混排截图）')
const img = await fs.readFile(path.join(import.meta.dirname, 'fixtures', 'ocr-sample.png'))
const r = await recognize(img)
check(`识别出 ≥3 行（实际 ${r.lines.length}）`, r.lines.length >= 3)
check('英文行原文正确', r.lines.some((l) => l.text.includes('Hello Agent Lab')))
check('数字/编号行识别到', r.lines.some((l) => l.text.includes('2026-1103')))
check('中文行被归一（无「发 票」碎片）', r.lines.some((l) => l.text.includes('发票')) && !r.lines.some((l) => l.text.includes('发 票')))
check('每行都带坐标（复制定位/高亮的依据）', r.lines.every((l) => l.bbox && l.bbox.y1 > l.bbox.y0))
check('按版面顺序排序（y 递增）', r.lines.every((l, i) => i === 0 || r.lines[i - 1].bbox.y0 <= l.bbox.y0))
check(`整体置信 > 60（实际 ${Math.round(r.confidence)}）`, r.confidence > 60)

await terminateOcr()
console.log(`\n探针结果: ${pass}/${pass + fail} ${fail === 0 ? '✓ 全过' : '✗ 有失败——看上面归因'}`)
if (fail > 0) process.exitCode = 1
