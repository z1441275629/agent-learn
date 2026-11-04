// 服务端共享状态：进程级单例 + 两个跨路由的运行时状态（确认门 / 会话互斥）。
// 从入口 app/路由里分离出来，是因为它们被多条路由共享（chat 出卡、confirm 应答、sessions 删除清授权），
// 放在一起谁都能 import，不用穿过 HTTP 层传引用。
import { loadConfig } from '../core/config.ts'
import { createSessionStore } from '../core/sessions.ts'
import { createMemoryStore, extractMemories, mergeMemoryList, shouldAcceptExtraction } from '../core/memories.ts'
import { createKbStore } from '../core/rag.ts'
import { builtinTools } from '../tools.ts'
import { resolveAsrConfig } from '../asr.ts'
import { createBrowserReader, type BrowserReader } from '../browser.ts'
import { MODELS } from '../models.ts'
import { thinkingParams } from '../models.ts'

/** 进程级配置与存储（dataDir 由 env 决定，一个进程一份） */
export const config = loadConfig()
export const store = createSessionStore(config.dataDir)
export const memories = createMemoryStore(config.dataDir)
export const kb = createKbStore(config.dataDir)
// 无头浏览器执行器（computer use 只读 v1）：PA_BROWSER=0 关掉（工具面不注册 browser_read）；
// 实例惰性——首次真正读网页才拉起 Chromium
export const browser: BrowserReader | undefined = process.env.PA_BROWSER === '0' ? undefined : createBrowserReader()
export const tools = builtinTools({ kb, memories, browser })
// 大模型转写配置（PA_ASR_* 可整体换平台；缺省回落备用/小档/embed 档的按量端点与 key）
export const ASR = resolveAsrConfig(process.env)

/** 同一会话同时只跑一轮：多标签页/重复点击时，后来的请求 409，避免账本写乱 */
export const runningSessions = new Set<string>()

// ---------- 写入工具确认门：SSE 出卡 → 人点允许/拒绝 → 循环继续 ----------
// 门在服务端持有：循环层只拿到一个 Promise<boolean>；没人应答（超时/断流）按拒绝收尾，
// 永不无限挂着等——「人没说话」对工具而言就是「不行」
export const CONFIRM_TIMEOUT_MS = Number(process.env.PA_CONFIRM_TIMEOUT_MS || 120_000)
export type ConfirmOutcome = 'approved' | 'denied' | 'timeout'
export interface PendingConfirm {
  sid: string
  name: string
  settle: (approve: boolean, outcome: ConfirmOutcome) => void
}
export const pendingConfirms = new Map<string, PendingConfirm>()

// 会话级「总是允许」：确认卡上勾了才进这里（内存态，重启即清——长期授权是危险品，
// 刻意不给它落盘）；本会话内同工具的后续调用直接放行，不再出卡
export const sessionAllows = new Map<string, Set<string>>()

// ---------- 记忆抽取钩子：回答完成后异步跑，绝不阻塞/弄崩对话 ----------
// 课程 07 的教训在这条链上全用得上：
//   - 不 await 的钩子里异常逃逸 = unhandled rejection 崩进程——必须自己消化
//   - 两个会话同时抽取 = 同一文件的读改写竞态——串行化（链式 promise）
//   - 输出不合法/清空式输出 = 守门拒绝、大声报错，记忆保持原样（静默丢记忆比崩溃更糟）
let memoryChain: Promise<void> = Promise.resolve()
export function runMemoryExtraction(sid: string, userText: string): void {
  memoryChain = memoryChain
    .then(async () => {
      if (!config.memoryEnabled) return
      const extractor = MODELS.find((m) => m.id === 'light') ?? MODELS[0]
      const existing = await memories.list()
      const result = await extractMemories(
        extractor.client,
        extractor.model,
        existing.map((e) => e.text),
        // 只喂用户发言：助手的回答是派生内容（检索/生成，甚至幻觉），进记忆等于把
        // 它固化——知识库删了、模型改口了，记忆里的旧答案还在（实测踩过）
        [{ role: 'user', text: userText }],
        { thinkingParams: thinkingParams('off') },
      )
      if (!shouldAcceptExtraction(result.texts, existing.length)) {
        console.warn(`[pa] 记忆抽取想清空 ${existing.length} 条——拒绝（真要清空请用界面）`)
        return
      }
      const diff = mergeMemoryList(existing, result.texts)
      if (diff.added.length === 0 && diff.removed.length === 0) return // 没变化不写盘
      await memories.save(diff.entries)
      console.log(
        `[pa] 记忆更新：+${diff.added.length} -${diff.removed.length} → 共 ${diff.entries.length} 条` +
          `（抽取 ${result.promptTokens}+${result.completionTokens} tokens）· session ${sid}`,
      )
      for (const t of diff.added) console.log(`[pa] 记忆 + ${t}`)
      for (const t of diff.removed) console.log(`[pa] 记忆 - ${t}`)
    })
    .catch((err: any) => console.error(`[pa] 记忆抽取失败（本轮跳过，记忆保持原样）：${err?.message ?? err}`))
}
