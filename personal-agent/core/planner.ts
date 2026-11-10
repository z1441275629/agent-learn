// 模块 16 第二层·规划师：把复杂多步请求拆成顺序步骤表（严格 JSON，fail-closed）。
// 路由预筛（router.ts）判 plan 后由 chat 层调用；解析失败/调用失败一律 null——调用方回落
// 单 agent 主路径，规划挂了不伤对话（小档 + 思考关：拆步骤是判断题不是推理题）。
import { thinkingParams, type ModelEntry } from '../models.ts'

export interface PlanStep {
  /** 一步的目标：一句话、动词开头、自包含（执行者只看到 原始请求 + 本步 goal + 前序摘要） */
  goal: string
  /** blog = 走博客编排；agent = 通用子 agent（全套工具 + 技能自动注入） */
  capability: 'blog' | 'agent'
}

const MAX_STEPS = 4

const PLANNER_PROMPT = [
  '角色：你是任务规划师。把用户的复杂请求拆成顺序执行的步骤，每步调用一个已有能力。',
  '能力清单（capability 只能取这两个值）：',
  '- blog：写技术博客——走多 agent 编排（研究员取材→审校→写手→审校→存 blogs/，落盘有确认卡），goal 给博客主题',
  '- agent：通用 agent 步骤——带全套工具（检索知识库/git 提交/读写文件/存笔记等，写入会弹确认卡），goal 写清这步要产出什么',
  '规则：',
  `- 最多 ${MAX_STEPS} 步，按依赖排序；能并行的也排成先后（当前编排器只串行）`,
  '- 每步 goal 一句话、动词开头、自包含——执行者只能看到用户原始请求、本步 goal 和前序步骤的摘要，看不到规划细节',
  '- 场景匹配已有技能（如复盘 = learning-review）时在 goal 里点名技能名，执行器会自动加载技能全文',
  '- 单一意图（如只是写一篇博客）就输出一步，别硬拆',
  '输出严格 JSON，不要任何多余文字：',
  '{"steps":[{"goal":"…","capability":"blog"|"agent"}]}',
].join('\n')

/** 解析规划师输出：剥围栏 → JSON → 校验/归一 → 截断 ≤4 步。任何失败 null（fail-closed） */
export function parsePlan(raw: string): PlanStep[] | null {
  const text = String(raw ?? '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
  let parsed: any
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!Array.isArray(parsed?.steps)) return null
  const steps: PlanStep[] = parsed.steps
    .filter((s: any) => s && typeof s.goal === 'string' && s.goal.trim())
    .slice(0, MAX_STEPS)
    .map((s: any) => ({
      goal: String(s.goal).trim(),
      capability: s.capability === 'blog' ? ('blog' as const) : ('agent' as const),
    }))
  return steps.length ? steps : null
}

/** planTask 的产物：步骤表 + 规划师自身的 usage（成本账要诚实——chat 层并入总汇报） */
export interface PlanOutcome {
  steps: PlanStep[]
  promptTokens: number
  completionTokens: number
}

/** 规划师单发调用（小档由调用方解析好传 entry）。任何失败返回 null——回落单 agent，不抛 */
export async function planTask(
  text: string,
  opts: { entry: ModelEntry; signal?: AbortSignal },
): Promise<PlanOutcome | null> {
  try {
    const resp = await opts.entry.client.chat.completions.create(
      {
        model: opts.entry.model,
        messages: [
          { role: 'system', content: PLANNER_PROMPT },
          { role: 'user', content: text },
        ],
        ...thinkingParams('off'),
      },
      opts.signal ? { signal: opts.signal } : {},
    )
    const steps = parsePlan(resp.choices?.[0]?.message?.content ?? '')
    if (!steps) return null
    return {
      steps,
      promptTokens: Number(resp.usage?.prompt_tokens) || 0,
      completionTokens: Number(resp.usage?.completion_tokens) || 0,
    }
  } catch {
    // 网络/中止/限流都按「规划不可用」处理——fail-closed 回落单 agent，别让规划挂了炸对话
    return null
  }
}
