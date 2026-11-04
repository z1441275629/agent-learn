// 个人 Agent 工作台 · 模块 13 探针：零 token（OCR 全本地，不调任何 LLM）
// 跑法：node personal-agent/probe.ts
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { recognize, normalizeCjk, terminateOcr } from './ocr.ts'
import { needsTranslation } from './translate.ts'
import { parseVisionLines } from './vision-ocr.ts'
import { buildApiMessages, deriveTitle, type StoredMessageLike } from './chat.ts'
import { createSessionStore, parseImageDataUrl } from './core/sessions.ts'

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

console.log('Q5 消息构建（图片只随最近一条 user 消息发送：历史图片每轮都重新计费）')
{
	const PNG_BYTES = Buffer.from(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
		'base64',
	)
	const messages: StoredMessageLike[] = [
		{ role: 'user', text: '看图', images: [{ file: 'a.png', name: 'a.png' }] },
		{ role: 'assistant', text: '收到', images: [] },
		{ role: 'user', text: '这张呢', images: [{ file: 'b.png', name: 'b.png' }] },
	]
	const loaded: string[] = []
	const loadImage = async (file: string) => {
		loaded.push(file)
		return { mime: 'image/png', data: PNG_BYTES }
	}
	const out = await buildApiMessages(messages, { loadImage })
	const first = out[0].content as any[]
	const last = out[2].content as any[]
	check('最近一条 user 的图片保留为 image_url', last.some((p) => p.type === 'image_url' && p.image_url.url.startsWith('data:image/png;base64,')))
	check('历史图片降级成文字占位', first.some((p) => p.type === 'text' && p.text.includes('a.png') && p.text.includes('已省略')))
	check('历史图片不再有 image_url', !first.some((p) => p.type === 'image_url'))
	check('省略的图片零 I/O（只读了最近一张）', loaded.length === 1 && loaded[0] === 'b.png', loaded.join(','))
	check('assistant 文本原样透传', out[1].content === '收到')
	{
		const all = await buildApiMessages(messages, { elideOldImages: false, loadImage })
		check('关闭省略开关时历史图片也读盘/保留', loaded.includes('a.png') && (all[0].content as any[]).some((p) => p.type === 'image_url'))
	}
	{
		const withError: StoredMessageLike[] = [...messages, { role: 'assistant', text: '', images: [], error: 'boom' }]
		const api = await buildApiMessages(withError, { loadImage })
		check('失败消息不进上下文', api.length === 3)
	}
	{
		const missing = await buildApiMessages(messages, { loadImage: async () => null })
		check('图片文件缺失时跳过该图、不炸整轮', Array.isArray(missing) && missing.length === 3)
	}
	check('标题取第一条可读文本', deriveTitle('  你好呀\n第二行', false) === '你好呀')
	check('纯图片会话有兜底标题', deriveTitle('', true) === '图片对话')
	check('附件行不作为标题', deriveTitle('附件 a.txt：\n```\n正文\n```', false) !== '附件 a.txt：')
}

console.log('Q6 会话存储（根目录可配置、原子写、图片与 JSON 分离）')
{
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pa-probe-'))
	const store = createSessionStore(tmp)
	const doc = await store.create()
	check('新会话 id 合法且标题默认', /^[A-Za-z0-9_-]+$/.test(doc.id) && doc.title === '新对话')
	check('空会话列表包含它', (await store.list()).some((s) => s.id === doc.id))

	const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
	const image = await store.saveImage(doc.id, PNG, '截图.png')
	check('图片落盘为独立文件（JSON 里不存 base64）', image.file.endsWith('.png') && image.mime === 'image/png')
	const back = await store.readImage(doc.id, image.file)
	check('读回的图片字节一致', !!back && back.mime === 'image/png' && back.data.length > 0)
	check('拒绝 http URL 图片', parseImageDataUrl('https://example.com/a.png') === null)

	await store.append(doc.id, { role: 'user', text: '你好', images: [image] }, { title: '第一条标题' })
	await store.append(doc.id, { role: 'assistant', text: '收到', images: [], model: 'm', elapsedMs: 12 })
	const loadedDoc = await store.load(doc.id)
	check('追加后消息成对且带自增 id', loadedDoc?.messages.length === 2 && loadedDoc.messages[1].id === 2)
	check('标题只由第一条 user 消息设定', loadedDoc?.title === '第一条标题')
	const summary = (await store.list()).find((s) => s.id === doc.id)
	check('列表返回标题与消息数', summary?.title === '第一条标题' && summary.messageCount === 2)

	await store.remove(doc.id)
	check('删除后列表不再包含它', !(await store.list()).some((s) => s.id === doc.id))
	await fs.rm(tmp, { recursive: true, force: true })
}

await terminateOcr()
console.log(`\n探针结果: ${pass}/${pass + fail} ${fail === 0 ? '✓ 全过' : '✗ 有失败——看上面归因'}`)
if (fail > 0) process.exitCode = 1
