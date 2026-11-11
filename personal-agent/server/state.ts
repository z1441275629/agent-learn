// 服务端共享状态：进程级单例 + 两个跨路由的运行时状态（确认门 / 会话互斥）。
// 从入口 app/路由里分离出来，是因为它们被多条路由共享（chat 出卡、confirm 应答、sessions 删除清授权），
// 放在一起谁都能 import，不用穿过 HTTP 层传引用。
import { loadConfig } from '../core/config.ts'
import { createSessionStore } from '../core/sessions.ts'
import { createMemoryStore, extractMemories, mergeMemoryList, shouldAcceptExtraction } from '../core/memories.ts'
import { createKbStore } from '../core/rag.ts'
import { createVectorLane } from '../vector-lane.ts'
import { createSkillStore } from '../core/skills.ts'
import { createRepoReader } from '../repo.ts'
import { builtinTools } from '../tools.ts'
import { loadMcpTools } from '../mcp-tools.ts'
import { resolveAsrConfig } from '../asr.ts'
import { createBrowserReader, type BrowserReader } from '../browser.ts'
import { describeScreenshot } from '../shot-vision.ts'
import { MODELS } from '../models.ts'
import { thinkingParams } from '../models.ts'
import { decodeImage } from './http.ts'
import fs from 'node:fs'
import path from 'node:path'

/** 进程级配置与存储（dataDir 由 env 决定，一个进程一份） */
export const config = loadConfig()
export const store = createSessionStore(config.dataDir)
export const memories = createMemoryStore(config.dataDir)
// 知识库：BM25 一路始终在（本地/零成本/确定性）；向量通道可选注入（Chroma 派生索引 +
// 嵌入 API，向量为主 BM25 补位——实验依据 chroma/chromadb-notes.md §12）。PA_KB_VECTOR=0
// 整体关掉回到纯 BM25；通道自身任何故障也自动降级，不炸检索
export const kb = createKbStore(config.dataDir, process.env.PA_KB_VECTOR === '0' ? undefined : createVectorLane())
// 无头浏览器执行器（computer use 只读 v1）：PA_BROWSER=0 关掉（工具面不注册 browser_read）；
// 实例惰性——首次真正读网页才拉起 Chromium
export const browser: BrowserReader | undefined = process.env.PA_BROWSER === '0' ? undefined : createBrowserReader()
// 截图存盘（体检报告里的 markdown 图指到这里；目录封顶 20 张，旧的自然淘汰）
const SHOTS_DIR = path.join(config.dataDir, 'browser-shots')
export const shots = {
  dir: SHOTS_DIR,
  save(dataUrl: string): { file: string; url: string } {
    const buf = decodeImage(dataUrl)
    fs.mkdirSync(SHOTS_DIR, { recursive: true })
    const file = `shot_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}.png`
    fs.writeFileSync(path.join(SHOTS_DIR, file), buf)
    try {
      const names = fs.readdirSync(SHOTS_DIR).filter((n) => n.endsWith('.png'))
      if (names.length > 20) {
        const withTime = names.map((n) => ({ n, t: fs.statSync(path.join(SHOTS_DIR, n)).mtimeMs })).sort((a, b) => b.t - a.t)
        for (const { n } of withTime.slice(20)) fs.unlinkSync(path.join(SHOTS_DIR, n))
      }
    } catch {
      /* 清理失败不碍事——下张截图再试 */
    }
    return { file, url: `/api/browser/shots/${file}` }
  },
}
// 视觉描述子调用：视觉档配置存在才接；没配/失败都在工具层降级成「无描述」，不断体检报告
const visionEntry = MODELS.find((m) => m.id === 'vision' && m.vision)
export const shotVision = visionEntry
  ? { describe: (dataUrl: string) => describeScreenshot(visionEntry.client, visionEntry.model, dataUrl) }
  : undefined
// 技能注册表（模块 15）：skills/ 目录的 SKILL.md 文档——系统提示注入索引、use_skill 按需加载全文
export const skills = createSkillStore(config.skillsDir)
// 仓库能力（模块 15）：git_log/read_file/write_file 的基座；dataDir 若是仓库子目录要挡读
const repoRoot = path.resolve(config.repoDir)
const dataResolved = path.resolve(config.dataDir)
const denyReads = dataResolved === repoRoot || dataResolved.startsWith(repoRoot + path.sep) ? [dataResolved] : []
export const repo = createRepoReader({ repoDir: config.repoDir, writableDirs: config.writableDirs, denyReads })
// 外部 MCP 工具（.mcp.json 驱动）：启动连一次进程长持，连不上降级空表——外部工具是增强不是依赖。
// PA_MCP=0 整体关闭。风险分级见 mcp-tools.ts 头注（risk 缺省 write 走确认门）
const mcpTools = await loadMcpTools()
export const tools = [...builtinTools({ kb, memories, skills, repo, browser, shots, vision: shotVision }), ...mcpTools]
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
