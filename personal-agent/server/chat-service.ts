// 对话域服务：会话详情视图 / 上下文预算调度（摘要+滑窗）/ 知识库注入。
// 不含 HTTP 概念——路由层调它们，纯逻辑可直接被未来的探针复用
import type { SessionDoc } from '../core/sessions.ts'
import { buildApiMessages } from '../chat.ts'
import { MODELS, thinkingParams } from '../models.ts'
import { memorySystemContent } from '../core/memories.ts'
import { renderKbBlock, withKbContext } from '../core/rag.ts'
import {
  applyWindow,
  messagesTokens,
  splitForCompaction,
  storedMessagesTokens,
  summarizeConversation,
} from '../core/context.ts'
import { renderSkillIndex } from '../core/skills.ts'
import { config, store, memories, kb, skills } from './state.ts'

export interface ChatBody {
  sessionId?: string | null
  message?: { text?: string; images?: { dataUrl?: string; name?: string }[] }
  modelId?: string
  thinking?: string
  imageElision?: boolean
  kbSearch?: boolean
  /** 工具调用开关（默认开）；关闭后连 get_time 都不给，纯聊天 */
  tools?: boolean
}

// ---------- 会话账本：给前端展示的形状（图片走独立 URL，不把 base64 塞回 JSON） ----------
export function sessionDetail(doc: SessionDoc) {
  return {
    id: doc.id,
    title: doc.title,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    modelId: doc.modelId,
    thinking: doc.thinking,
    messages: doc.messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.text,
      images: m.images.map((im) => ({
        src: `/api/sessions/${doc.id}/images/${im.file}`,
        name: im.name,
      })),
      usage: m.usage,
      model: m.model,
      elapsedMs: m.elapsedMs,
      error: m.error,
      interrupted: m.interrupted,
      tools: m.tools,
    })),
  }
}

/** 保存失败只大声报错，不把正在进行的对话带崩（持久化是增强不是依赖） */
export async function safeAppend(
  id: string,
  message: Parameters<typeof store.append>[1],
  opts?: Parameters<typeof store.append>[2],
): Promise<SessionDoc | null> {
  try {
    return await store.append(id, message, opts)
  } catch (err: any) {
    console.error(`[pa] 会话 ${id} 保存失败：${err?.message}`)
    return null
  }
}

/** 用最新一条 user 文本检索知识库；命中才注入。寒暄级短查询不值得打扰索引（worthSearching） */
export async function kbContextFor(doc: SessionDoc): Promise<string | null> {
  const query = [...doc.messages].reverse().find((m) => m.role === 'user')?.text ?? ''
  const hits = await kb.search(query)
  if (!hits.length) return null
  console.log(`[pa] 知识库检索：${hits.length} 命中（top ${hits[0].score.toFixed(2)} 分《${hits[0].docName}》）`)
  return renderKbBlock(hits)
}

// ---------- 上下文预算：摘要 + 滑窗（core/context.ts 的调度层） ----------
/**
 * 把会话账本变成这次要发给模型的 messages，并在超预算时按三层防线处理：
 *   ① 图片省略交给 buildApiMessages（旧图零 I/O）
 *   ② 旧轮 → LLM 摘要，摘要与截止点落盘（之后每轮只发「摘要 + 截止点之后」）
 *   ③ 摘要失败/仍超预算 → 滑动窗口按整轮丢最旧，最新一轮永远保留
 *
 * 摘要用 light 档并关思考：压缩是确定性的信息整理，不值得付主模型的价和推理预算。
 */
export async function prepareContext(
  doc: SessionDoc,
  entry: (typeof MODELS)[number],
  elideOldImages: boolean,
  kbBlock: string | null,
  toolsOn: boolean,
) {
  const memoryEntries = config.memoryEnabled ? await memories.list() : []
  // 工具模式下知识库走 search_kb 工具（模型自主检索），自动注入关闭——同一内容不双份进上下文；
  // 有库时给一句使用引导，否则模型可能不知道该查
  const kbCount = toolsOn ? (await kb.list()).length : 0
  const guidance =
    toolsOn && kbCount > 0
      ? '用户有个人知识库（个人笔记）；问题涉及其个人记录、安排、项目时，先用 search_kb 工具检索再回答。'
      : ''
  // 技能索引（模块 15）：只给触发条件（name+description），agent 匹配时用 use_skill 加载全文再照做
  const skillSummaries = toolsOn ? await skills.index() : []
  const skillsBlock = skillSummaries.length ? renderSkillIndex(skillSummaries) : ''
  // 触发自动加载：用户消息命中某技能 frontmatter 的 triggers 关键词就把正文直接进上下文。
  // 实测模型（尤其小档、思考关）常跳过 use_skill 凭记忆自由发挥——自动加载是可靠兜底，不依赖模型自觉。
  // 匹配用全会话的用户消息：跟进式提问（如「那前天呢」）不带触发词，也保持加载不丢。
  const userTexts = doc.messages
    .filter((m) => m.role === 'user')
    .map((m) => (m.text ?? '') as string)
    .join('\n')
  const preloadedSkills = toolsOn ? await skills.match(userTexts) : []
  const preloadedBlock = preloadedSkills.length
    ? '以下技能本次请求已匹配触发条件自动加载，直接严格照技能步骤执行（不必再调 use_skill）：\n' +
      preloadedSkills.map((s) => `【技能 ${s.name}】\n触发条件：${s.description}\n\n${s.body}`).join('\n\n')
    : ''
  const systemContent = [
    memoryEntries.length ? memorySystemContent(memoryEntries) : '',
    guidance,
    skillsBlock,
    preloadedBlock,
  ]
    .filter(Boolean)
    .join('\n')
  const basePrefix = systemContent ? 1 : 0
  const buildView = async (messages: SessionDoc['messages'], summary: string | undefined) => {
    // 知识库块塞进最后一条 user 消息（只进发送视图不落账本）；token 计量在注入之后，
    // 预算决策看到的是真实发送大小
    const api = withKbContext(
      await buildApiMessages(messages, {
        elideOldImages,
        loadImage: (file) => store.readImage(doc.id, file),
      }),
      kbBlock,
    )
    return [
      // 记忆+引导是 system 前缀、摘要是 user 前缀——开窗时这些前缀都要保住（prefixCount 见下）
      ...(systemContent ? [{ role: 'system', content: systemContent }] : []),
      ...(summary ? [{ role: 'user', content: `【前情摘要】\n${summary}` }] : []),
      ...api,
    ]
  }

  const view = await buildView(
    doc.messages.filter((m) => m.id > (doc.summaryUntil ?? 0)),
    doc.summary,
  )
  const tokens = messagesTokens(view)
  if (tokens <= config.contextBudget) return view

  const active = doc.messages.filter((m) => m.id > (doc.summaryUntil ?? 0))
  const plan = splitForCompaction(active, {
    budgetTokens: config.contextBudget,
    tokenOfTurn: (turn) => storedMessagesTokens(turn),
  })
  if (plan.summarize.length === 0) {
    console.warn(`[pa] 上下文 ${Math.round(tokens)} > 预算 ${config.contextBudget}，但没有可压缩的旧轮——开窗兜底`)
    return applyWindow(view, config.contextBudget, basePrefix + (doc.summary ? 1 : 0))
  }

  const summarizer = MODELS.find((m) => m.id === 'light') ?? entry
  try {
    const result = await summarizeConversation(summarizer.client, summarizer.model, plan.summarize, doc.summary, {
      thinkingParams: thinkingParams('off'),
    })
    const until = Math.max(...plan.summarize.map((m) => m.id))
    await store.setSummary(doc.id, result.summary, until)
    doc.summary = result.summary
    doc.summaryUntil = until

    const next = await buildView(plan.retained, result.summary)
    const after = messagesTokens(next)
    console.log(
      `[pa] 上下文压缩：${Math.round(tokens)} → ${Math.round(after)} tokens` +
        `（摘要 ${result.promptTokens}+${result.completionTokens} tokens，覆盖到消息 ${until}）· session ${doc.id}`,
    )
    if (after > config.contextBudget) {
      console.warn(`[pa] 压缩后仍超预算——开窗兜底`)
      return applyWindow(next, config.contextBudget, basePrefix + 1)
    }
    return next
  } catch (err: any) {
    console.error(`[pa] 摘要失败，退回滑动窗口：${err?.message ?? err}`)
    return applyWindow(view, config.contextBudget, basePrefix + (doc.summary ? 1 : 0))
  }
}
