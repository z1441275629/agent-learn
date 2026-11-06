// 工作台的具体工具面（注册表）。通用循环在 core/agent.ts；这里只定义「这个产品有哪些工具」。
//
// 只读工具（risk:'read'，自动放行）：
//   - get_time：回答「今天/现在」类问题的锚点——模型对当前时间永远是无知的，别让它猜
//   - search_kb：模型自主检索知识库——比固定自动注入强在可以换关键词多查几次（多跳问题），
//     且「要不要查」由模型判断；工具模式下自动注入关闭，避免同一内容双份进上下文
// 写入工具（risk:'write'，循环层确认门批准才跑）：
//   - remember：把用户明确要记的事实写进长期记忆（课程 07 的 A 路线）——参数原文
//     会出现在确认卡上，人批的才是账上的（PITFALLS #39：派生内容不得未经批准长命于源头）
//   - forget：删一条记忆——text 必须与系统提示里的记忆原文完全一致，不许模型自由发挥
//   - add_note：存一条笔记进知识库（search_kb 的写侧对偶）
// 浏览器（模块 14 computer use）：browser_read 读（带元素索引），browser_click / browser_type
//   操作（写侧，过确认门）——「选择器注入式」路线：read 给可操作元素打 ref，操作按 ref 定位，
//   页面变了 ref 作废报错重读。PA_BROWSER=0 时整个浏览器工具面不注册（deps.browser 为空）

import { newId, type MemoryStore } from './core/memories.ts'
import type { ToolDef } from './core/agent.ts'
import type { KbStore } from './core/rag.ts'
import type { SkillStore } from './core/skills.ts'
import type { RepoReader } from './repo.ts'
import { assertNavigableUrl, formatInspectResult, formatPageForModel, validateRefArg, type BrowserReader } from './browser.ts'

/** ref 参数在工具层快失败（守门与执行器同一份 validateRefArg）：坏 ref 不值得出确认卡 */
function checkedRef(value: unknown): number | string {
  try {
    return validateRefArg(value)
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
  }
}

export interface BuiltinToolDeps {
  kb: KbStore
  memories: MemoryStore
  /** 技能注册表（skills/ 目录）：有它才注册 use_skill 加载工具 */
  skills?: SkillStore
  /** 仓库能力（git_log/read_file/write_file）：有它才注册三个工具 */
  repo?: RepoReader
  browser?: BrowserReader
  /** 截图存盘（体检工具要给人看图，注册 inspect 需要） */
  shots?: { save(dataUrl: string): { url: string } }
  /** 视觉描述子调用（可选——没配视觉档就降级成纯控制台体检） */
  vision?: { describe(dataUrl: string): Promise<string> }
}

export function builtinTools(deps: BuiltinToolDeps): ToolDef[] {
  const browserTool: ToolDef[] = deps.browser
    ? [
        {
          name: 'browser_read',
          description:
            '用无头浏览器读取网页：带 url 时打开该网页（http/https 完整地址，读不了本机文件），不带 url 时读取当前已打开的页面（点击/输入之后看结果用，不会重新导航）。返回页面标题、最终地址、JS 渲染后的正文，以及「可操作元素」索引——每个可点击/可输入的元素带一个 [编号]，是 browser_click / browser_type 的操作目标。编号只在当前页面状态下有效，页面变化（点击/跳转）后要重新调用本工具拿新编号。',
          parameters: {
            type: 'object',
            properties: {
              url: { type: 'string', description: '要打开的网页完整地址；省略 = 读当前页面' },
            },
            required: [],
          },
          risk: 'read',
          run: async (args) => {
            const raw = String(args?.url ?? '').trim()
            // 先在工具层快失败（守门与执行器同一份 assertNavigableUrl）：非法 URL 不值得叫醒浏览器
            if (raw) {
              try {
                assertNavigableUrl(raw)
              } catch (err) {
                return JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
              }
            }
            try {
              return formatPageForModel(await deps.browser!.read(raw || undefined))
            } catch (err) {
              return JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
            }
          },
        },
        {
          name: 'browser_click',
          description:
            '点击当前网页上的一个元素（链接/按钮等）。ref 是 browser_read 返回的可操作元素编号——必须先读过页面拿到编号才能点击。点击后页面可能跳转或变化，旧编号全部作废：要看结果就再 browser_read（不带 url，读当前页）。执行前用户会在确认卡上看到要点的是哪个元素并批准。',
          parameters: {
            type: 'object',
            properties: {
              ref: { type: 'number', description: 'browser_read 元素索引里的编号，如 3' },
            },
            required: ['ref'],
          },
          risk: 'write',
          // 确认卡不能给人看 {"ref":3}——解析成「点的是哪个元素」（最近一次快照的登记表；
          // 页面变了解析不出就明说，人批卡批的是看得懂的东西）
          describe: (args) => {
            const ref = Number(args?.ref)
            const where = Number.isInteger(ref) ? deps.browser!.describeRef(ref) : null
            return `点击网页元素 ${where ?? `编号 ${JSON.stringify(args?.ref)}（无法解析对应元素，可能页面已变化）`}`
          },
          run: async (args) => {
            const ref = checkedRef(args?.ref)
            if (typeof ref !== 'number') return ref
            try {
              const r = await deps.browser!.click(ref)
              return `已点击 [${ref}]。现在页面：《${r.title}》 ${r.url}\n要看新页面的内容，请再调 browser_read（不带 url）。`
            } catch (err) {
              return JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
            }
          },
        },
        {
          name: 'browser_type',
          description:
            '在当前网页的一个输入框里填入文字。ref 是 browser_read 返回的可操作元素编号（要指向输入框）；submit 传 true 时填完按回车提交（可能触发搜索/跳转，跳转后旧编号作废，要再 browser_read 看结果）。执行前用户会在确认卡上看到要往哪个输入框填什么再批准。',
          parameters: {
            type: 'object',
            properties: {
              ref: { type: 'number', description: 'browser_read 元素索引里输入框的编号' },
              text: { type: 'string', description: '要填入的文字' },
              submit: { type: 'boolean', description: '填完后按回车提交（默认 false）' },
            },
            required: ['ref', 'text'],
          },
          risk: 'write',
          describe: (args) => {
            const ref = Number(args?.ref)
            const where = Number.isInteger(ref) ? deps.browser!.describeRef(ref) : null
            const text = String(args?.text ?? '')
            return `往网页输入框 ${where ?? `编号 ${JSON.stringify(args?.ref)}（无法解析对应元素，可能页面已变化）`} 填入：${text.slice(0, 80)}`
          },
          run: async (args) => {
            const ref = checkedRef(args?.ref)
            if (typeof ref !== 'number') return ref
            const text = String(args?.text ?? '')
            if (!text) return JSON.stringify({ error: 'text 不能为空' })
            const submit = args?.submit === true
            try {
              const r = await deps.browser!.type(ref, text, submit)
              return submit
                ? `已在 [${ref}] 填入并回车提交。现在页面：《${r.title}》 ${r.url}\n要看结果，请再调 browser_read（不带 url）。`
                : `已在 [${ref}] 填入（未提交）。`
            } catch (err) {
              return JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
            }
          },
        },
        // 体检（开发调试）：截图存盘（报告里带 markdown 图，界面直接渲染）+ 视觉描述（视觉档
        // 子调用，主模型不用吃图）+ 控制台（确定性半边）。shots 没接就不注册
        ...(deps.shots
          ? [
              {
                name: 'browser_inspect',
                description:
                  '体检一个网页（开发调试用）：打开页面（带 url）或检查当前页（不带 url），截图保存（报告里能看到图）、给出视觉模型对界面的描述、以及自本次加载起的控制台消息——JS 报错、console.error/warn、请求失败、HTTP 4xx/5xx。分析页面为什么不对、白屏、报错时用它；要看文字内容用 browser_read。',
                parameters: {
                  type: 'object',
                  properties: {
                    url: { type: 'string', description: '要体检的网页地址；省略 = 体检当前已打开的页面' },
                  },
                  required: [],
                },
                risk: 'read',
                run: async (args: any) => {
                  const raw = String(args?.url ?? '').trim()
                  if (raw) {
                    try {
                      assertNavigableUrl(raw)
                    } catch (err) {
                      return JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
                    }
                  }
                  let page: Awaited<ReturnType<BrowserReader['inspect']>>
                  try {
                    page = await deps.browser!.inspect(raw || undefined)
                  } catch (err) {
                    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
                  }
                  const shot = deps.shots!.save(page.screenshot)
                  let visionText: string | undefined
                  let visionError: string | undefined
                  if (deps.vision) {
                    try {
                      visionText = await deps.vision.describe(page.screenshot)
                    } catch (err) {
                      visionError = err instanceof Error ? err.message.split('\n')[0] : String(err)
                    }
                  }
                  return formatInspectResult({
                    url: page.url,
                    title: page.title,
                    shotUrl: shot.url,
                    visionText,
                    visionError,
                    consoleEntries: page.console,
                  })
                },
              } as ToolDef,
            ]
          : []),
      ]
    : []

  return [
    {
      name: 'get_time',
      description: '获取当前日期和时间。任何涉及「今天/现在/几点/几号」的问题先调用它，不要自己推算。',
      parameters: { type: 'object', properties: {}, required: [] },
      risk: 'read',
      run: async () => {
        const now = new Date()
        const weekdays = ['日', '一', '二', '三', '四', '五', '六']
        return `现在时间是 ${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日 星期${weekdays[now.getDay()]} ${now.toTimeString().slice(0, 8)}（本机时区）`
      },
    },
    {
      name: 'search_kb',
      description:
        '在用户的个人知识库（其上传的个人笔记）里按关键词检索，返回最相关的片段。问题涉及用户自己的记录、笔记、项目、安排时，先检索再回答；检索不到就说明没有，不要编造。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '检索关键词，尽量用笔记里可能出现的原词' } },
        required: ['query'],
      },
      risk: 'read',
      run: async (args) => {
        const query = String(args?.query ?? '').trim()
        if (!query) return JSON.stringify({ error: 'query 不能为空' })
        // chatterGate:false——要不要查由模型决定，寒暄闸不替它把关（「组会」单关键词也放行）
        const hits = await deps.kb.search(query, 3, { chatterGate: false })
        if (!hits.length) return '知识库中没有检索到相关内容。'
        return hits.map((h, i) => `[${i + 1}]《${h.docName}》（相关度 ${h.score.toFixed(2)}）\n${h.text}`).join('\n\n')
      },
    },
    // 技能加载（模块 15 skill）：系统提示里有技能索引（name+触发条件），用户需求匹配时先加载全文再照做
    ...(deps.skills
      ? [
          {
            name: 'use_skill',
            description:
              '加载一个技能的完整说明。系统提示的「可用技能」列表里有每个技能的名字和触发条件；当用户的请求匹配某个技能的触发条件时，先调用本工具加载该技能全文（name 用列表里的名字），然后严格照技能文档里的步骤执行。技能文档是用户沉淀的固定流程——不要凭印象跳过步骤。',
            parameters: {
              type: 'object',
              properties: { name: { type: 'string', description: '技能名（系统提示「可用技能」列表里的名字）' } },
              required: ['name'],
            },
            risk: 'read',
            run: async (args) => {
              const name = String(args?.name ?? '').trim()
              if (!name) return JSON.stringify({ error: 'name 不能为空' })
              const doc = await deps.skills!.load(name)
              if (!doc) return JSON.stringify({ error: `没有找到技能 ${name}——用系统提示「可用技能」列表核对名字` })
              return `# 技能 ${doc.name}\n\n## 触发条件\n${doc.description}\n\n## 步骤\n${doc.body}`
            },
          } as ToolDef,
        ]
      : []),
    // 仓库能力（模块 15）：git_log/read_file 只读；write_file 写侧（白名单目录 + 确认门）
    ...(deps.repo
      ? ([
          {
            name: 'git_log',
            description:
              '查看这个仓库的 git 提交历史。涉及「最近的提交、这周/今天按提交干了什么」时调用。since 是时间窗（如 today 00:00、3 days、2026-11-05），省略 = 最近一天；max 最多条数（默认 20）。返回「提交号 日期 消息」列表。',
            parameters: {
              type: 'object',
              properties: {
                since: { type: 'string', description: '时间窗，如 today 00:00 / 3 days / 2026-11-05；省略 = 最近一天' },
                max: { type: 'number', description: '最多条数，默认 20' },
              },
              required: [],
            },
            risk: 'read',
            run: async (args) => {
              try {
                return await deps.repo!.gitLog(String(args?.since ?? '').trim() || undefined, Number(args?.max) || 20)
              } catch (err) {
                return JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
              }
            },
          },
          {
            name: 'read_file',
            description:
              '读取仓库里的一个文件（仓库相对路径，如 reviews/2026-11-06.md）。读复盘、日志、文档时用；超长自动截断标注。',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string', description: '仓库相对路径，如 reviews/2026-11-06.md' } },
              required: ['path'],
            },
            risk: 'read',
            run: async (args) => {
              try {
                return await deps.repo!.readFile(String(args?.path ?? '').trim())
              } catch (err) {
                return JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
              }
            },
          },
          {
            name: 'write_file',
            description:
              '把内容写入仓库里的一个文件（仓库相对路径）。只能写白名单目录（reviews/、personal-agent/skills/ 等）。执行前用户会在确认卡上看到路径和内容并批准；批准后覆盖写入。写复盘文件、技能文档时用。',
            parameters: {
              type: 'object',
              properties: {
                path: { type: 'string', description: '仓库相对路径，如 reviews/2026-11-06.md（必须在白名单目录内）' },
                content: { type: 'string', description: '要写入的完整内容' },
              },
              required: ['path', 'content'],
            },
            risk: 'write',
            describe: (args) => {
              const rel = String(args?.path ?? '')
              const content = String(args?.content ?? '')
              return `写入文件 ${rel}（${content.length} 字符）：${content.slice(0, 120)}${content.length > 120 ? '…' : ''}`
            },
            run: async (args) => {
              try {
                return await deps.repo!.writeFile(String(args?.path ?? '').trim(), String(args?.content ?? ''))
              } catch (err) {
                return JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
              }
            },
          },
        ] as ToolDef[])
      : []),
    {
      name: 'remember',
      description:
        '把一条关于用户的持久事实写入长期记忆（跨会话生效）。只在用户明确表达「记住这个」时调用；调用后用户会在确认卡上自行批准，不需要你先口头确认。text 用一句话陈述事实本身，不要夹带解释。',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: '要记住的事实，一句话' } },
        required: ['text'],
      },
      risk: 'write',
      run: async (args) => {
        const text = String(args?.text ?? '').trim()
        if (!text) return JSON.stringify({ error: 'text 不能为空' })
        if (text.length > 300) return JSON.stringify({ error: '单条记忆太长（>300 字），拆成更短的事实' })
        let existed = false
        // mutate：读改写全程串行——与后台抽取钩子共用 memories.json，不许在窗口里互相覆盖
        await deps.memories.mutate((entries) => {
          existed = entries.some((e) => e.text === text)
          if (existed) return entries
          const iso = new Date().toISOString()
          return [...entries, { id: newId(), text, createdAt: iso, updatedAt: iso }]
        })
        return existed ? '这条记忆已经存在，无需重复记录。' : `已记住：${text}`
      },
    },
    {
      name: 'forget',
      description:
        '从长期记忆中删除一条记忆。系统提示里列出了当前全部记忆——要删哪条，就把那条记忆的原文一字不差地传给 text。用户明确要求「忘记/删掉某条记忆」时必须调用本工具执行：不调用、记忆就不会真的消失，不要只用文字声称已删除；调用后由用户在确认卡上批准，不需要你再口头向用户确认一遍。',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: '要删除的记忆原文（与系统提示里的条目完全一致）' } },
        required: ['text'],
      },
      risk: 'write',
      run: async (args) => {
        const text = String(args?.text ?? '').trim()
        if (!text) return JSON.stringify({ error: 'text 不能为空' })
        let found = false
        await deps.memories.mutate((entries) => {
          found = entries.some((e) => e.text === text)
          return found ? entries.filter((e) => e.text !== text) : entries
        })
        return found ? `已忘记：${text}` : `没有找到这条记忆（text 必须与记忆原文完全一致）：${text.slice(0, 60)}`
      },
    },
    {
      name: 'add_note',
      description:
        '把一段内容作为新笔记存入用户的个人知识库（之后可用 search_kb 检索到）。用户明确要求「存到笔记/记到知识库」时调用；text 是笔记正文，title 是简短标题。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '笔记标题，简短（如「青竹项目要点」）' },
          text: { type: 'string', description: '笔记正文' },
        },
        required: ['text'],
      },
      risk: 'write',
      run: async (args) => {
        const text = String(args?.text ?? '').trim()
        if (!text) return JSON.stringify({ error: 'text 不能为空' })
        const title = String(args?.title ?? '').trim() || `对话笔记 ${new Date().toISOString().slice(0, 10)}`
        const doc = await deps.kb.add(title, text)
        return `已存入知识库：《${doc.name}》（${doc.chunkCount} 块），之后可用 search_kb 检索。`
      },
    },
    ...browserTool,
  ]
}
