// 产品核心：流式工具循环（agent loop）
//
// 课程 03（Function Calling）→ 09（harness）的循环都是非流式的；工作台的对话是 SSE 流式，
// 这里把两者合起来：每轮流式出字，模型改要工具时累积 tool_call 分片 → 执行 → 喂回 → 下一轮。
//
// 从课程带过来的纪律：
//   - dispatch 是所有工具调用的唯一咽喉：永远返回字符串、永远不抛——
//     错误是喂给模型的信息，不是崩循环的理由
//   - 空工具面必须省略 tools 字段（空数组在部分 API 是禁用、部分是报错，PITFALLS #25）
//   - 步数上限：超限后最后一轮去掉 tools 强制出文本答案，不许工具死循环烧钱
//   - 工具结果截断：源头减量，别等超预算再救（模块 06 的 token 经济学）
//
// 权限门（risk 分级 + 确认 UI）在本层留了钩子：v1 只注册 read 工具（自动放行），
// write 工具 + 「人批」确认流是下一层——闸门结构先就位，不和使用面一起堆。

import type OpenAI from 'openai'

export interface ToolDef {
  name: string
  description: string
  /** JSON Schema（OpenAI function.parameters 形状） */
  parameters: Record<string, unknown>
  /** read = 只读自动放行；write = 需要确认门（下一层接确认流，现在不放行） */
  risk: 'read' | 'write'
  /** 永远返回字符串（喂给模型的内容），实现内部自己消化异常 */
  run: (args: any) => Promise<string>
}

export interface ToolTrace {
  name: string
  args: string
  result: string
  ms: number
}

export interface AgentLoopResult {
  /** 所有轮的文本拼接（工具轮的 preamble 也算数，不丢字） */
  text: string
  /** 跨轮累加的 usage（prompt/completion/total/cached/reasoning 全部求和） */
  usage: Record<string, any> | null
  rounds: number
  trace: ToolTrace[]
  /** 上游流被 abort 但 SDK 正常收尾时为 true（PITFALLS #38：取消是状态不是异常） */
  aborted: boolean
}

export interface AgentLoopOptions {
  tools: ToolDef[]
  /** 工具轮上限，超过后最后一轮去掉 tools 强制文本答案 */
  maxRounds?: number
  /** 单个工具结果的字符上限（截断在源头做） */
  maxResultChars?: number
  signal?: AbortSignal
  /** 额外请求参数（思考开关等），原样展开进 create 的 body */
  extraBody?: Record<string, unknown>
  onText?: (delta: string) => void
  onToolCall?: (trace: ToolTrace) => void
}

export function truncateToolResult(result: string, maxChars = 1200): string {
  if (result.length <= maxChars) return result
  return result.slice(0, Math.floor(maxChars * 0.85)) + '\n…[结果过长已截断]'
}

/** 工具调用唯一咽喉：查定义 → 解析参数 → 执行 → 截断。任何失败都变成喂给模型的字符串 */
async function dispatch(
  def: ToolDef | undefined,
  name: string,
  argsRaw: string,
  maxResultChars: number,
): Promise<string> {
  if (!def) return JSON.stringify({ error: `未注册的工具 ${name}` })
  let args: any
  try {
    args = argsRaw ? JSON.parse(argsRaw) : {}
  } catch (err: any) {
    return JSON.stringify({ error: `参数不是合法 JSON：${err?.message ?? err}` })
  }
  try {
    return truncateToolResult(await def.run(args), maxResultChars)
  } catch (err: any) {
    return JSON.stringify({ error: `工具执行失败：${err?.message ?? err}` })
  }
}

/** 累加服务商 usage（多轮求和；明细字段存在才累加，不伪造） */
function sumUsage(total: Record<string, any> | null, u: any): Record<string, any> | null {
  if (!u) return total
  const next = total ?? {}
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
    if (typeof u[key] === 'number') next[key] = (next[key] ?? 0) + u[key]
  }
  if (typeof u.prompt_tokens_details?.cached_tokens === 'number') {
    next.prompt_tokens_details = {
      cached_tokens: (next.prompt_tokens_details?.cached_tokens ?? 0) + u.prompt_tokens_details.cached_tokens,
    }
  }
  if (typeof u.completion_tokens_details?.reasoning_tokens === 'number') {
    next.completion_tokens_details = {
      reasoning_tokens:
        (next.completion_tokens_details?.reasoning_tokens ?? 0) + u.completion_tokens_details.reasoning_tokens,
    }
  }
  return next
}

export async function runToolLoop(
  client: OpenAI,
  model: string,
  messages: any[],
  options: AgentLoopOptions,
): Promise<AgentLoopResult> {
  const { tools, maxRounds = 5, maxResultChars = 1200, signal, extraBody, onText, onToolCall } = options
  const toolsParam = tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
  const byName = new Map(tools.map((t) => [t.name, t]))

  let text = ''
  let usage: Record<string, any> | null = null
  let rounds = 0
  const trace: ToolTrace[] = []

  while (true) {
    const includeTools = rounds < maxRounds
    const stream = (await client.chat.completions.create(
      {
        model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        ...(includeTools && toolsParam.length ? { tools: toolsParam } : {}), // 空面必须省略而不是 []（PITFALLS #25）
        ...(extraBody ?? {}),
      } as any,
      { signal },
    )) as any

    let roundText = ''
    // tool_call 分片按 index 累积：id/name 一般首个分片到，arguments 逐段拼接
    const calls = new Map<number, { id: string; name: string; args: string }>()
    for await (const chunk of stream) {
      if (chunk.usage) usage = sumUsage(usage, chunk.usage)
      const delta = chunk.choices?.[0]?.delta
      if (delta?.content) {
        roundText += delta.content
        text += delta.content
        onText?.(delta.content)
      }
      for (const tc of delta?.tool_calls ?? []) {
        const slot = calls.get(tc.index) ?? { id: '', name: '', args: '' }
        if (tc.id) slot.id = tc.id
        if (tc.function?.name) slot.name += tc.function.name
        if (tc.function?.arguments) slot.args += tc.function.arguments
        calls.set(tc.index, slot)
      }
    }
    if (signal?.aborted) return { text, usage, rounds, trace, aborted: true }
    if (calls.size === 0) return { text, usage, rounds, trace, aborted: false }

    // 达到轮数上限还想要工具：去掉 tools 的最后一轮已经发了（includeTools=false）却仍回工具调用——
    // 放弃继续，把已出的文本交回去（空文本给个说明，别让界面收到一句没有）
    if (!includeTools) {
      return { text: text || '（工具调用轮数已达上限，未能生成回答）', usage, rounds, trace, aborted: false }
    }

    messages.push({
      role: 'assistant',
      content: roundText || null,
      tool_calls: [...calls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([_, c]) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } })),
    })
    for (const [_, call] of [...calls.entries()].sort(([a], [b]) => a - b)) {
      const t0 = Date.now()
      const result = await dispatch(byName.get(call.name), call.name, call.args, maxResultChars)
      const item: ToolTrace = { name: call.name, args: call.args, result, ms: Date.now() - t0 }
      trace.push(item)
      onToolCall?.(item)
      messages.push({ role: 'tool', tool_call_id: call.id, content: result })
    }
    rounds++
  }
}
