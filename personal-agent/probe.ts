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
import {
  createMemoryStore,
  extractMemories,
  buildExtractionUserPrompt,
  memorySystemContent,
  mergeMemoryList,
  parseMemoryList,
  shouldAcceptExtraction,
} from './core/memories.ts'
import {
  IMAGE_TOKEN_ESTIMATE,
  applyWindow,
  contentTokens,
  estimateTokens,
  groupTurns,
  messagesTokens,
  renderMessagesForSummary,
  splitForCompaction,
  storedMessagesTokens,
  summarizeConversation,
} from './core/context.ts'

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
check(
  '英文行原文正确',
  r.lines.some((l) => l.text.includes('Hello Agent Lab')),
)
check(
  '数字/编号行识别到',
  r.lines.some((l) => l.text.includes('2026-1103')),
)
check(
  '中文行被归一（无「发 票」碎片）',
  r.lines.some((l) => l.text.includes('发票')) && !r.lines.some((l) => l.text.includes('发 票')),
)
check(
  '每行都带坐标（复制定位/高亮的依据）',
  r.lines.every((l) => l.bbox && l.bbox.y1 > l.bbox.y0),
)
check(
  '按版面顺序排序（y 递增）',
  r.lines.every((l, i) => i === 0 || r.lines[i - 1].bbox!.y0 <= l.bbox!.y0),
)
check(`整体置信 > 60（实际 ${Math.round(r.confidence ?? 0)}）`, (r.confidence ?? 0) > 60)
check('本地引擎标记 engine=local 且每行带坐标', r.engine === 'local' && r.lines.every((l) => !!l.bbox))

console.log('Q4 AI 引擎输出解析（纯函数：模型不总听话，围栏/两种行形状都要接住）')
check(
  '标准形状 {"lines":[{"text":..}]}',
  parseVisionLines('{"lines":[{"text":"第一行"},{"text":"第二行"}]}').join('|') === '第一行|第二行',
)
check('剥 ```json 围栏', parseVisionLines('```json\n{"lines":[{"text":"a"}]}\n```').join('') === 'a')
check('宽容字符串数组 [".."]', parseVisionLines('{"lines":["a","b"]}').join('|') === 'a|b')
check('前后废话只取 JSON 段', parseVisionLines('好的，结果如下：{"lines":[{"text":"x"}]} 以上。').join('') === 'x')
check('空行被过滤', parseVisionLines('{"lines":[{"text":"a"},{"text":"  "}]}').length === 1)
{
  let threw = false
  try {
    parseVisionLines('抱歉我无法识别')
  } catch {
    threw = true
  }
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
  check(
    '最近一条 user 的图片保留为 image_url',
    last.some((p) => p.type === 'image_url' && p.image_url.url.startsWith('data:image/png;base64,')),
  )
  check(
    '历史图片降级成文字占位',
    first.some((p) => p.type === 'text' && p.text.includes('a.png') && p.text.includes('已省略')),
  )
  check('历史图片不再有 image_url', !first.some((p) => p.type === 'image_url'))
  check('省略的图片零 I/O（只读了最近一张）', loaded.length === 1 && loaded[0] === 'b.png', loaded.join(','))
  check('assistant 文本原样透传', out[1].content === '收到')
  {
    const all = await buildApiMessages(messages, { elideOldImages: false, loadImage })
    check(
      '关闭省略开关时历史图片也读盘/保留',
      loaded.includes('a.png') && (all[0].content as any[]).some((p) => p.type === 'image_url'),
    )
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
  check(
    '空会话列表包含它',
    (await store.list()).some((s) => s.id === doc.id),
  )

  const PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
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

  await store.setSummary(doc.id, '前情摘要正文', 2)
  const withSummary = await store.load(doc.id)
  check('摘要与截止点可落盘/重读', withSummary?.summary === '前情摘要正文' && withSummary?.summaryUntil === 2)

  await store.remove(doc.id)
  check('删除后列表不再包含它', !(await store.list()).some((s) => s.id === doc.id))
  await fs.rm(tmp, { recursive: true, force: true })
}

console.log('Q7 上下文预算（token 估算 / 轮分组 / 摘要+滑窗兜底）')
{
  check('中文按 1 token/字估算', estimateTokens('你好世界') === 4)
  check('英文按 4 字符/token 估算', estimateTokens('abcdefgh') === 2)
  check(
    '多模态 content：文本估算 + 图片固定估算',
    contentTokens([
      { type: 'text', text: 'abcdefgh' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ]) ===
      2 + IMAGE_TOKEN_ESTIMATE,
  )
  check('消息级估算含每条固定开销', messagesTokens([{ content: 'abcdefgh' }]) === 2 + 4)
  {
    // 历史图片降级后的文本占位真实 token 很低——存储形状按张数估，不能按 base64 长度估
    const stored = [{ text: '', images: [{}] }]
    check('存储形状图片按张数估（不是 base64 长度）', storedMessagesTokens(stored) === IMAGE_TOKEN_ESTIMATE + 4)
  }

  const turns = groupTurns([{ role: 'user' }, { role: 'assistant' }, { role: 'assistant' }, { role: 'user' }])
  check(
    '轮分组：user 开头，后续 assistant 归入该轮',
    turns.length === 2 && turns[0].length === 3 && turns[1].length === 1,
  )

  {
    const messages = [
      { role: 'user' as const },
      { role: 'assistant' as const },
      { role: 'user' as const },
      { role: 'assistant' as const },
      { role: 'user' as const },
    ]
    const plan = splitForCompaction(messages, { budgetTokens: 100, tokenOfTurn: () => 40 })
    check('保留区从最新轮往回装到半预算内', plan.retained.length === 1 && plan.retained[0].role === 'user')
    check('更早的完整轮交给摘要', plan.summarize.length === 4 && plan.summarize[3].role === 'assistant')
    {
      const huge = splitForCompaction(messages, { budgetTokens: 10, tokenOfTurn: () => 1000 })
      check(
        '最新一轮超预算也必留（正在进行的任务不能被摘要掉）',
        huge.retained.length === 1 && huge.summarize.length === 4,
      )
    }
  }

  {
    const prefix = [{ role: 'user', content: '摘要' }]
    const messages = [
      ...prefix,
      { role: 'user', content: '一二三四五六七八' }, // 8 tokens
      { role: 'assistant', content: '一二三四五六七八' },
      { role: 'user', content: '一二三四五六七八' },
      { role: 'assistant', content: '一二三四五六七八' },
      { role: 'user', content: '最新问题' },
    ]
    const windowed = applyWindow(messages, 20, 1)
    check('滑窗保留摘要前缀', windowed[0].content === '摘要')
    check('滑窗按整轮丢最旧（只剩前缀 + 最新一轮）', windowed.length === 2)
    check('滑窗一定保留最新一轮', windowed[windowed.length - 1].content === '最新问题')
    check('滑窗估算不超预算', messagesTokens(windowed) <= 20)
  }

  {
    const rendered = renderMessagesForSummary(
      [
        { role: 'user', text: '目标在这里', images: [{ name: '截图.png' }] },
        { role: 'assistant', text: '', error: '上游 500' },
        { role: 'assistant', text: 'x'.repeat(50) },
      ],
      20,
    )
    check('摘要输入排除失败消息', !rendered.includes('上游 500'))
    check('摘要输入用图片占位符而不是 base64', rendered.includes('[图片 截图.png 未展开]'))
    check('长消息截断且保留头尾', rendered.includes('…[截断]…') && rendered.startsWith('用户：目标在这里'))
  }

  {
    let captured: any
    const fakeClient = {
      chat: {
        completions: {
          create: async (params: any) => {
            captured = params
            return {
              choices: [{ message: { content: '  摘要正文  ' } }],
              usage: { prompt_tokens: 12, completion_tokens: 3 },
            }
          },
        },
      },
    } as any
    const result = await summarizeConversation(
      fakeClient,
      'light-model',
      [
        { role: 'user', text: '早先目标' },
        { role: 'assistant', text: '好的' },
      ],
      '旧摘要',
      { thinkingParams: { thinking: { type: 'disabled' } } },
    )
    check('摘要正文去空白后返回', result.summary === '摘要正文')
    check('usage 透出（摘要成本可观测）', result.promptTokens === 12 && result.completionTokens === 3)
    check(
      '系统提示词要求压缩对话',
      captured.messages[0].role === 'system' && captured.messages[0].content.includes('压缩成摘要'),
    )
    check(
      '合并输入同时带旧摘要与新对话',
      captured.messages[1].content.includes('旧摘要') && captured.messages[1].content.includes('早先目标'),
    )
    check('不传 tools（空数组在部分平台会报错）', !('tools' in captured))
    check('思考开关参数透传（摘要不该付思考预算）', captured.thinking?.type === 'disabled')
    {
      const emptyClient = {
        chat: { completions: { create: async () => ({ choices: [{ message: { content: '   ' } }] }) } },
      } as any
      let code = 0
      try {
        await summarizeConversation(emptyClient, 'm', [{ role: 'user', text: 'x' }], undefined)
      } catch (err: any) {
        code = err?.code ?? 0
      }
      check('空摘要明确报 502（触发窗口兜底，不静默吞掉上下文）', code === 502)
    }
  }
}

console.log('Q8 长期记忆（抽取输出守门 / 完整列表重放 / 存储回环）')
{
  check('标准数组解析', parseMemoryList('["a","b"]')?.join('|') === 'a|b')
  check('剥围栏 + 前后废话截取 JSON 段', parseMemoryList('好的：```json\n["a"]\n``` 完成')?.[0] === 'a')
  check('空白条目被过滤', parseMemoryList('["a","  "]')?.length === 1)
  check('非数组返回 null（不许静默吞）', parseMemoryList('{"items":[]}') === null)
  check('对象元素返回 null（形状不对就是不对）', parseMemoryList('[{"text":"a"}]') === null)
  check('超长条目返回 null（提示词约束每条一句话）', parseMemoryList(`["${'x'.repeat(301)}"]`) === null)
  check('彻底不是 JSON 返回 null', parseMemoryList('抱歉我无法完成') === null)

  {
    const now = new Date('2026-11-04T00:00:00Z')
    const existing = [
      { id: 'm1', text: '用户家里 5 口人', createdAt: '2026-11-01', updatedAt: '2026-11-01' },
      { id: 'm2', text: '用户在做 Agent 开发', createdAt: '2026-11-02', updatedAt: '2026-11-02' },
    ]
    const diff = mergeMemoryList(existing, ['用户在做 Agent 开发', '用户 2026-11-04 起每天跑步'], now)
    check('措辞未变的条目沿用原 id（同一条记忆不是新记忆）', diff.entries[0].id === 'm2')
    check('新文本发新 id + 时间戳', diff.entries[1].id !== 'm1' && diff.entries[1].createdAt === now.toISOString())
    check(
      'diff 正确报告增删',
      diff.added.join() === '用户 2026-11-04 起每天跑步' && diff.removed.join() === '用户家里 5 口人',
    )
  }

  check('守门：已有记忆非空时拒绝清空式输出', shouldAcceptExtraction([], 3) === false)
  check('守门：空库接受空列表（还没有可丢的）', shouldAcceptExtraction([], 0) === true)
  check('守门：非空列表总是接受', shouldAcceptExtraction(['a'], 3) === true)

  check(
    'system 注入含全部条目与使用说明',
    memorySystemContent([{ text: 'A' }, { text: 'B' }]).includes('- A') &&
      memorySystemContent([{ text: 'A' }]).includes('长期记忆'),
  )
  {
    const prompt = buildExtractionUserPrompt(['旧事实'], '用户：新对话', '2026-11-04')
    check('抽取输入带今天日期（绝对日期规则的锚点）', prompt.includes('今天是 2026-11-04'))
    check(
      '抽取输入同时带已有记忆与新对话',
      prompt.includes('【已有记忆】') && prompt.includes('- 旧事实') && prompt.includes('【新对话】'),
    )
  }

  {
    let captured: any
    const fakeClient = {
      chat: {
        completions: {
          create: async (params: any) => {
            captured = params
            return {
              choices: [{ message: { content: '["记忆甲"]' } }],
              usage: { prompt_tokens: 30, completion_tokens: 5 },
            }
          },
        },
      },
    } as any
    const result = await extractMemories(fakeClient, 'light-model', ['旧事实'], [{ role: 'user', text: '记住：甲' }], {
      thinkingParams: { thinking: { type: 'disabled' } },
    })
    check('抽取返回解析后的列表与 usage', result.texts.join() === '记忆甲' && result.promptTokens === 30)
    check('抽取系统提示词含「一条不能丢」约束', captured.messages[0].content.includes('一条不能丢'))
    check('抽取关思考（不付推理预算）', captured.thinking?.type === 'disabled')
    check('抽取不传 tools', !('tools' in captured))
    {
      const brokenClient = {
        chat: { completions: { create: async () => ({ choices: [{ message: { content: '我说不了' } }] }) } },
      } as any
      let code = 0
      try {
        await extractMemories(brokenClient, 'm', [], [{ role: 'user', text: 'x' }])
      } catch (err: any) {
        code = err?.code ?? 0
      }
      check('抽取输出不合法明确报 502（守门触发，记忆保持原样）', code === 502)
    }
  }

  {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pa-mem-'))
    const memStore = createMemoryStore(tmp)
    check('空库返回空列表', (await memStore.list()).length === 0)
    const now = new Date('2026-11-04T00:00:00Z')
    const diff = mergeMemoryList([], ['事实一', '事实二'], now)
    await memStore.save(diff.entries)
    const loaded = await memStore.list()
    check('保存/读回一致', loaded.length === 2 && loaded[0].text === '事实一')
    check('删除存在的 id 返回 true', (await memStore.remove(loaded[0].id)) === true)
    check('删除后的列表少一条', (await memStore.list()).length === 1)
    check('删除不存在的 id 返回 false', (await memStore.remove('nope')) === false)
    await memStore.clear()
    check('清空后为空', (await memStore.list()).length === 0)
    await fs.rm(tmp, { recursive: true, force: true })
  }
}

await terminateOcr()
console.log(`\n探针结果: ${pass}/${pass + fail} ${fail === 0 ? '✓ 全过' : '✗ 有失败——看上面归因'}`)
if (fail > 0) process.exitCode = 1
