// 模块 14 computer use 第一块底座：无头浏览器执行器（只读 v1）。
// 路线是「选择器注入式」的第一步——先给模型「打开网页、读 JS 渲染后正文」的手；
// 点击/输入（写侧，走确认门）与截图纯视觉路线是后续层，执行器到时候还是这一个。
// 约定：本文件只做浏览器域的事（守门/等待/取正文），不认识工具循环；
// 工具面在 tools.ts，模型可见的字符串整形也在那边拼。

import { chromium } from 'playwright'

/** 喂给模型的正文上限：页面文本轻松上万字，先在这里截（循环层还有一道 maxResultChars） */
export const MAX_TEXT_CHARS = 6000
/** URL 长度上限：防御性——模型幻觉出的超长串别去解析 */
const MAX_URL_CHARS = 2048

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

export interface FetchedPage {
  /** 最终地址（跟了重定向后），和请求的可能不同——模型要知道自己真读了哪页 */
  url: string
  title: string
  text: string
}

/** 纯函数·结果整形：喂给模型的字符串形状（标题/最终地址/正文），探针钉死 */
export function formatPageForModel(p: FetchedPage): string {
  return `《${p.title}》\n${p.url}\n\n${p.text}`
}

/** 工具面依赖的最小接口（tools.ts 只认这个，不认 playwright） */
export interface BrowserReader {
  read(rawUrl: string): Promise<FetchedPage>
  close(): Promise<void>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * 浏览器单例工厂：首次 read 才拉起 Chromium（不拖慢服务启动），
 * 之后复用同一个标签页；read 之间互斥（工具循环的只读并发会把多个 read 同时扔进来，
 * 一个 page 同时只够一个导航，排队跑——墙钟是 sum，这是浏览器的物理约束不是策略）。
 */
export function createBrowserReader(): BrowserReader {
  type LaunchedBrowser = Awaited<ReturnType<typeof chromium.launch>>
  let browser: LaunchedBrowser | null = null
  let page: Awaited<ReturnType<LaunchedBrowser['newPage']>> | null = null
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

  async function doRead(rawUrl: string): Promise<FetchedPage> {
    const url = assertNavigableUrl(rawUrl)
    browser ??= await chromium.launch({ headless: true })
    if (!page) {
      page = await browser.newPage()
      page.setDefaultNavigationTimeout(20_000)
    }
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      // JS 渲染兜底：等网络静默（3s 竞速放弃——带轮询/分析的页面永远不静默）再小憩。
      // 覆盖 setTimeout 注入与懒加载两种「DOM 就绪但内容没到」；纯静态页这段几乎零耗时
      await Promise.race([page.waitForLoadState('networkidle'), sleep(3000)]).catch(() => {})
      await sleep(400)
      const text = capText(await page.evaluate(() => document.body?.innerText ?? ''))
      return { url: page.url(), title: await page.title(), text }
    } catch (err) {
      // 渲染进程可能已被站点搞崩（page crash 后这个 page 永远 Target closed）——丢弃换新
      const dead = page
      page = null
      await dead?.close().catch(() => {})
      const msg = err instanceof Error ? err.message.split('\n')[0] : String(err)
      throw new Error(`页面打开失败：${msg}（${url}）`)
    }
  }

  return {
    read: (rawUrl: string) => enqueue(() => doRead(rawUrl)),
    close: async () => {
      page = null
      const b = browser
      browser = null
      await b?.close().catch(() => {})
    },
  }
}
