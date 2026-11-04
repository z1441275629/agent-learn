// 模块 14 computer use 执行器：无头浏览器（Playwright Chromium）。
// v1 只读（browser_read）；v2 操作闭环——browser_read 的返回带「元素索引」（ref 快照，
// 选择器注入式：给可操作元素打 data-pa-ref 属性 + 列出 [ref] 类型「文本」），
// browser_click / browser_type 按 ref 操作（写侧，工具层过确认门）。
// 约定：本文件只做浏览器域的事（守门/等待/取正文/打 ref），不认识工具循环与确认门；
// 工具面在 tools.ts。DOM 会变，ref 只在「快照那一刻的页面」上有效——失效就报错让模型重读，
// 不猜。纯函数（守门/截断/格式化）全部导出给探针。

import { chromium } from 'playwright'

/** 喂给模型的正文上限：页面文本轻松上万字，先在这里截（循环层还有一道 maxResultChars） */
export const MAX_TEXT_CHARS = 6000
/** URL 长度上限：防御性——模型幻觉出的超长串别去解析 */
const MAX_URL_CHARS = 2048
/** 元素索引上限：长页面链接上百个，全列出来只会淹没正文 */
export const MAX_ELEMENTS = 80
/** 可操作元素的选择器：链接/按钮/输入/下拉 + 常见 ARIA role */
const INTERACTIVE_SELECTOR =
  'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="menuitem"]'

/**
 * 纯函数·URL 守门：只放行 http/https。
 * file:// 能读本机文件、javascript:/data: 是注入面，都不许进浏览器；错误信息说人话
 * （它会被喂回模型，模型要能据此改口给出合法 URL）。
 */
export function assertNavigableUrl(raw: string): string {
  const url = String(raw ?? '').trim()
  if (!url) throw new Error('url 不能为空')
  if (url.length > MAX_URL_CHARS) throw new Error(`url 太长（>${MAX_URL_CHARS} 字符），不像一个正常的网页地址`)
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`不是合法的 URL（要带协议的完整地址，如 https://example.com/page）：${url.slice(0, 60)}`)
  }
  const proto = parsed.protocol.toLowerCase()
  if (proto !== 'http:' && proto !== 'https:') {
    throw new Error(`只支持 http/https 网页地址，不支持 ${parsed.protocol}//（本工具只读公开网页，不开本机文件）`)
  }
  return url
}

/**
 * 纯函数·正文截断：保留头部 + 标注总长。巡检类问题头部（标题/摘要区）信息密度最高，
 * 截断要让人和模型都知道「后面还有多少」。
 */
export function capText(text: string, max = MAX_TEXT_CHARS): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n\n…（正文共 ${text.length} 字，只保留了前 ${max} 字；需要更多请说明要看哪部分）`
}

export interface ElementRef {
  ref: number
  /** 元素角色：标签名（input 带 :type），如 button / a / input:search */
  role: string
  /** 人可读标签：innerText/value/placeholder/aria-label 里第一个非空的 */
  label: string
}

/**
 * 纯函数·ref 参数校验：必须是正整数（模型可能给 "3"、3.0、负数——都在门口拦下说人话）。
 */
export function validateRefArg(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_ELEMENTS) {
    throw new Error(`ref 必须是元素索引里的正整数编号（1~${MAX_ELEMENTS}），收到的是：${JSON.stringify(value)}`)
  }
  return n
}

/**
 * 纯函数·元素索引格式化：`[N] role「label」` 一行一个；空列表返回空串（没有可操作元素
 * 就不出这一节，别让模型对着空列表猜）。
 */
export function formatRefSection(refs: ElementRef[], max = MAX_ELEMENTS): string {
  if (!refs.length) return ''
  const lines = refs.slice(0, max).map((e) => `[${e.ref}] ${e.role}${e.label ? `「${e.label}」` : ''}`)
  return [
    `可操作元素（[编号] 类型「文本」；编号只在当前页面状态下有效，点击/跳转后要重新 browser_read 获取新的索引）：`,
    ...lines,
  ].join('\n')
}

export interface FetchedPage {
  /** 最终地址（跟了重定向后），和请求的可能不同——模型要知道自己真读了哪页 */
  url: string
  title: string
  text: string
  /** 本次快照抓到的可操作元素（打 ref 的依据；点击/输入靠它） */
  refs: ElementRef[]
}

/** 纯函数·结果整形：喂给模型的字符串形状（标题/最终地址/正文/元素索引），探针钉死 */
export function formatPageForModel(p: FetchedPage): string {
  const head = `《${p.title}》\n${p.url}\n\n${p.text}`
  const section = formatRefSection(p.refs)
  return section ? `${head}\n\n${section}` : head
}

/** 工具面依赖的最小接口（tools.ts 只认这个，不认 playwright） */
export interface BrowserReader {
  /** 带 url = 导航后读；不带 url = 读当前页（点击/输入之后看结果，不重新导航） */
  read(rawUrl?: string): Promise<FetchedPage>
  /** 按 ref 点击（ref 来自最近一次 read 的元素索引；DOM 变了会报错） */
  click(ref: number): Promise<{ url: string; title: string }>
  /** 往 ref 指向的输入框填 text；submit=true 时回车提交（可能触发跳转） */
  type(ref: number, text: string, submit?: boolean): Promise<{ url: string; title: string }>
  /** 确认卡用：把 ref 解析成人话（最近一次快照的登记表；查不到返回 null） */
  describeRef(ref: number): string | null
  close(): Promise<void>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * 浏览器单例工厂：首次 read 才拉起 Chromium（不拖慢服务启动），之后复用同一个标签页；
 * 所有操作互斥排队（工具循环的只读并发会把多个 read 同时扔进来，一个 page 同时只够一个
 * 导航；write 过确认门后再进来，同样排队）。ref 登记表记「最近一次快照」——只用于确认卡
 * 解析，操作时永远以 DOM 里现存的 data-pa-ref 为准（登记表会过期，DOM 不会说谎）。
 */
export function createBrowserReader(): BrowserReader {
  type LaunchedBrowser = Awaited<ReturnType<typeof chromium.launch>>
  let browser: LaunchedBrowser | null = null
  let page: Awaited<ReturnType<LaunchedBrowser['newPage']>> | null = null
  let registry: Map<number, ElementRef> = new Map()
  // 互斥链：tail 永不 reject，job 的成败各自返回给调用方
  let tail: Promise<void> = Promise.resolve()
  function enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = tail.then(job, job)
    tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async function ensurePage() {
    browser ??= await chromium.launch({ headless: true })
    if (!page) {
      page = await browser.newPage()
      page.setDefaultNavigationTimeout(20_000)
    }
    return page
  }

  /** 操作后的等待：网络静默（2.5s 竞速放弃——轮询页面永远不静默）+ 小憩；顺手关掉
   *  target=_blank 弹出来的新标签页（v2 不支持多标签，别让它们堆积） */
  async function settle() {
    const p = page!
    await Promise.race([p.waitForLoadState('networkidle'), sleep(2500)]).catch(() => {})
    await sleep(300)
    const ctx = p.context()
    for (const other of ctx.pages()) if (other !== p) await other.close().catch(() => {})
  }

  /** 快照：清掉旧 ref → 给可见可操作元素重新编号并打 data-pa-ref → 返回索引。
   *  回调在浏览器里执行（playwright 序列化过去）——DOM 名字经 globalThis 取，
   *  不让 Node 的类型世界检查页面世界的代码（两边 lib 不同） */
  async function snapshot(): Promise<ElementRef[]> {
    const p = page!
    const refs = await p.evaluate((sel: string) => {
      const doc: any = (globalThis as any).document
      doc.querySelectorAll('[data-pa-ref]').forEach((e: any) => e.removeAttribute('data-pa-ref'))
      const out: { ref: number; role: string; label: string }[] = []
      for (const el of Array.from(doc.querySelectorAll(sel)) as any[]) {
        if (out.length >= 80) break
        const rect = el.getBoundingClientRect()
        if (rect.width === 0 && rect.height === 0) continue // 不可见的元素不给编号（点了也是空）
        // role 标注：input 的 type 默认 text 是有用信息照用；button 的 type 默认 submit 是
        // DOM 规范的噪音（不在表单里的按钮也报 submit），只在显式写了 type 时才带
        const tag = el.tagName.toLowerCase()
        const explicit = String(el.getAttribute('type') || '')
        const role = tag === 'button' ? tag + (explicit ? `:${explicit}` : '') : tag + (el.type ? `:${el.type}` : '')
        const label = (
          String(el.innerText || '').trim() ||
          String(el.value || '').trim() ||
          String(el.placeholder || '').trim() ||
          String(el.getAttribute('aria-label') || '').trim() ||
          String(el.name || '') ||
          String(el.title || '')
        )
          .replace(/\s+/g, ' ')
          .slice(0, 60)
        const ref = out.length + 1
        el.setAttribute('data-pa-ref', String(ref))
        out.push({ ref, role, label })
      }
      return out
    }, INTERACTIVE_SELECTOR)
    registry = new Map(refs.map((e) => [e.ref, e]))
    return refs
  }

  async function doRead(rawUrl?: string): Promise<FetchedPage> {
    const p = await ensurePage()
    const url = String(rawUrl ?? '').trim()
    if (url) {
      try {
        await p.goto(assertNavigableUrl(url), { waitUntil: 'domcontentloaded' })
      } catch (err) {
        return failRead(err, url)
      }
    } else if (!p.url() || p.url() === 'about:blank') {
      throw new Error('浏览器还没打开过页面——先带 url 调一次 browser_read')
    }
    // JS 渲染兜底：等网络静默（3s 竞速放弃——带轮询/分析的页面永远不静默）再小憩。
    // 覆盖 setTimeout 注入与懒加载两种「DOM 就绪但内容没到」；纯静态页这段几乎零耗时
    await Promise.race([p.waitForLoadState('networkidle'), sleep(3000)]).catch(() => {})
    await sleep(400)
    const text = capText(await p.evaluate(() => (globalThis as any).document.body?.innerText ?? ''))
    return { url: p.url(), title: await p.title(), text, refs: await snapshot() }
  }

  /** 导航失败收尾：丢弃可能已崩的 page（crash 后永远 Target closed），错误人话化 */
  async function failRead(err: unknown, url: string): Promise<never> {
    const dead = page
    page = null
    await dead?.close().catch(() => {})
    const msg = err instanceof Error ? err.message.split('\n')[0] : String(err)
    throw new Error(`页面打开失败：${msg}（${url}）`)
  }

  function refLocator(ref: number) {
    const p = page
    if (!p || !p.url() || p.url() === 'about:blank') {
      throw new Error('浏览器还没打开页面——先 browser_read 打开一个网页')
    }
    return p.locator(`[data-pa-ref="${ref}"]`).first()
  }

  async function requireRef(ref: number) {
    const loc = refLocator(ref)
    if ((await loc.count()) === 0) {
      throw new Error(
        `编号 ${ref} 在当前页面上找不到（页面可能已经变化，旧编号随旧页面作废）——重新 browser_read 获取新的元素索引再操作`,
      )
    }
    return loc
  }

  async function doClick(ref: number) {
    const loc = await requireRef(ref)
    await loc.click({ timeout: 8000 })
    await settle()
    return { url: page!.url(), title: await page!.title() }
  }

  async function doType(ref: number, text: string, submit = false) {
    const loc = await requireRef(ref)
    try {
      await loc.fill(text, { timeout: 8000 })
    } catch (err) {
      const msg = err instanceof Error ? err.message.split('\n')[0] : String(err)
      throw new Error(`填不进去（编号 ${ref} 可能不是输入框）：${msg}`)
    }
    if (submit) {
      await loc.press('Enter')
      await settle()
    }
    return { url: page!.url(), title: await page!.title() }
  }

  return {
    read: (rawUrl?: string) => enqueue(() => doRead(rawUrl)),
    click: (ref: number) => enqueue(() => doClick(ref)),
    type: (ref: number, text: string, submit?: boolean) => enqueue(() => doType(ref, text, submit)),
    describeRef: (ref: number) => {
      const e = registry.get(ref)
      return e ? `[${e.ref}] ${e.role}${e.label ? `「${e.label}」` : ''}` : null
    },
    close: async () => {
      page = null
      registry = new Map()
      const b = browser
      browser = null
      await b?.close().catch(() => {})
    },
  }
}
