// 个人 Agent 工作台 · 模块 13 探针：零 token（OCR 全本地，不调任何 LLM）
// 跑法：node personal-agent/probe.ts
import fs from 'node:fs/promises'
import path from 'node:path'
import { recognize, normalizeCjk, terminateOcr } from './ocr.ts'
import { needsTranslation } from './translate.ts'
import { parseVisionLines } from './vision-ocr.ts'
import { normalizeMessages, lastUserHasImages } from './chat.ts'

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
check('按版面顺序排序（y 递增）', r.lines.every((l, i) => i === 0 || r.lines[i - 1].bbox!.y0 <= l.bbox!.y0))
check(`整体置信 > 60（实际 ${Math.round(r.confidence ?? 0)}）`, (r.confidence ?? 0) > 60)
check('本地引擎标记 engine=local 且每行带坐标', r.engine === 'local' && r.lines.every((l) => !!l.bbox))

console.log('Q4 AI 引擎输出解析（纯函数：模型不总听话，围栏/两种行形状都要接住）')
check('标准形状 {"lines":[{"text":..}]}', parseVisionLines('{"lines":[{"text":"第一行"},{"text":"第二行"}]}').join('|') === '第一行|第二行')
check('剥 ```json 围栏', parseVisionLines('```json\n{"lines":[{"text":"a"}]}\n```').join('') === 'a')
check('宽容字符串数组 [".."]', parseVisionLines('{"lines":["a","b"]}').join('|') === 'a|b')
check('前后废话只取 JSON 段', parseVisionLines('好的，结果如下：{"lines":[{"text":"x"}]} 以上。').join('') === 'x')
check('空行被过滤', parseVisionLines('{"lines":[{"text":"a"},{"text":"  "}]}').length === 1)
{
	let threw = false
	try { parseVisionLines('抱歉我无法识别') } catch { threw = true }
	check('非 JSON 明确报错（触发重试，不静默返回空）', threw)
}

console.log('Q5 对话消息归一（图片只随最近一条 user 消息发送：历史图片每轮都重新计费）')
const PNG = 'data:image/png;base64,iVBORw0KGgo='
{
	const msgs = [
		{ role: 'user' as const, content: [{ type: 'text' as const, text: '看图' }, { type: 'image' as const, dataUrl: PNG, name: 'a.png' }] },
		{ role: 'assistant' as const, content: '收到' },
		{ role: 'user' as const, content: [{ type: 'image' as const, dataUrl: PNG, name: 'b.png' }, { type: 'text' as const, text: '这张呢' }] },
	]
	const out = normalizeMessages(msgs)
	const firstUser = out[0].content as any[]
	const lastUser = out[2].content as any[]
	check('最近一条 user 的图片保留为 image_url', lastUser.some((p) => p.type === 'image_url' && p.image_url.url === PNG))
	check('历史图片降级成文字占位（不再付图 token）', firstUser.some((p) => p.type === 'text' && p.text.includes('a.png') && p.text.includes('已省略')))
	check('历史图片不再有 image_url', !firstUser.some((p) => p.type === 'image_url'))
	check('字符串消息原样透传', out[1].content === '收到')
	check('关闭省略开关时历史图片保留', (normalizeMessages(msgs, false)[0].content as any[]).some((p) => p.type === 'image_url'))
	check('lastUserHasImages 认出最近一轮有图', lastUserHasImages(msgs))
	check('只有文本时 lastUserHasImages=false', lastUserHasImages([{ role: 'user', content: 'hi' }]) === false)
	{
		let threw = false
		try { normalizeMessages([{ role: 'user', content: [{ type: 'image', dataUrl: 'https://example.com/a.png' }] }]) } catch { threw = true }
		check('拒绝 http URL 图片（只收 dataURL 内联）', threw)
	}
	{
		let threw = false
		try { normalizeMessages([]) } catch { threw = true }
		check('空 messages 明确报错', threw)
	}
}

await terminateOcr()
console.log(`\n探针结果: ${pass}/${pass + fail} ${fail === 0 ? '✓ 全过' : '✗ 有失败——看上面归因'}`)
if (fail > 0) process.exitCode = 1
