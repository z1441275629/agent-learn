// 模块 11 §4：Langfuse 双写对照层——把 composite 的产线 trace 同步喂一份给 Langfuse（云端）
//
// §3 手写了最小 trace（TraceCollector：每次 run 落盘 JSON + 流转图 txt）。这节看框架白送什么：
//   §3 手写 span（token/耗时/结论/verdict/零成本事件）都收，但只能落本地 txt/JSON、要自己 renderFlow
//   §4 Langfuse 白送：开箱 UI 逐帧回放 / 趋势图 / 成本聚合，OTel 语义约定，存云端可多端看
//   交点：两条线是「双写」不是「替换」——同一产线 run，§3 落盘文件 + Langfuse trace 并存，截图对照
//
// 本文件只做三件事，把 OTel 细节全吞掉，composite 的 chargeR/chargeW 只加一行：
//   makeRun(topic, source)  → 一次产线 run = 一个 root span（name=topic）
//   spawnWindow(root, role, spawnResult) → 每次 spawn = 一个 generation（name=语义 role，token 从 SpawnResult 拿）
//   event(root, role, kind, verdict)     → 门检/熔断/短路 = 一个 event（零成本，Langfuse 也吃得了）
//   finish(root)  → root.end() + forceFlush()（fire-and-forget，不阻塞产线返回）
//
// no-op 守卫：key 没配（开发环境常态）就全部空跑——观测层绝不能 Throw 进产线主逻辑。
// key 只从 .env 读（LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_BASE_URL），源码永不出现真值。
//
// 对象模型映射（新栈 OTel 基 @langfuse/tracing v6，api 以 dist/index.d.ts 实录校准）：
//   一次 run        → asType:'span'      （root，name=topic，input=素材摘要）
//   每次 spawn      → asType:'generation'（name=语义 role，model=全局模型，usageDetails=token 双栏，output=结论）
//   门检/熔断/短路  → asType:'event'     （自动 end，statusMessage=verdict 归因）
import 'dotenv/config'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { LangfuseSpanProcessor } from '@langfuse/otel'
import { startObservation, type LangfuseSpan, type LangfuseGeneration, type LangfuseEvent } from '@langfuse/tracing'
import { MODEL } from '../09-harness/llm.ts'

// ---------- 读配置 + no-op 守卫 ----------
const publicKey = process.env.LANGFUSE_PUBLIC_KEY || ''
const secretKey = process.env.LANGFUSE_SECRET_KEY || ''
const baseUrl = process.env.LANGFUSE_BASE_URL || ''
// key 齐了才起观测；缺任一 → enabled=false，下面所有方法空跑（产线不能因观测崩，本地无 key 照常开发）
const disabled = publicKey === '' || secretKey === '' || baseUrl === ''
if (!disabled) {
  console.log('  [账] Langfuse 云观测已启用（本地 trace 照常落盘，双写并存）')
}
// @langfuse/otel 的 processor 是全局单例，不是每 run 一个 client——进程级别建一次，所有 run 共用
const processor = disabled ? null : new LangfuseSpanProcessor({ publicKey, secretKey, baseUrl, exportMode: 'immediate' })
if (processor) {
  // NodeTracerProvider 持有 processor，register() 挂为全局 tracer provider，startObservation 才能从 provider 拿 tracer
  // （官方 quickstart 就这条路，不是 sdk-node——Langfuse v6 要 OTel core ^2，sdk-node 旧通道 peer 对不上）
  new NodeTracerProvider({ spanProcessors: [processor] }).register()
}

// 一次产线 run 的 root handle——spawnWindow/event/finish 都拿它当父
export interface RunHandle {
  root: LangfuseSpan // root span，用 otelSpan.spanContext() 给子当 parentSpanContext
}

// 建一次产线 run 的 root span。key 没配返回 null，上层照常跑（双写关掉而已）
export function makeRun(topic: string, source: string): RunHandle | null {
  if (!processor) return null
  const root = startObservation(topic, { input: source.slice(0, 80), metadata: { topic, sourcePreview: source.slice(0, 80) } }, { asType: 'span' })
  return { root }
}

// 每次 spawn（chargeR/chargeW 处调）——token/耗时/结论全在 SpawnResult 手里，不用包装 OpenAI client
export function spawnWindow(handle: RunHandle | null, role: string, r: SpawnResult): void {
  if (!handle) return
  const gen: LangfuseGeneration = startObservation(
    role, // 语义 role 名（研究员修订#1 天然带序号）——Langfuse 和 §3 吃同一份，对照时名字对得上
    {
      model: r.model ?? MODEL, // §7 路由后按窗口实报（SpawnResult.model）——没路由的老窗口回落主模型名，云端成本聚合才不分错账
      usageDetails: { input: r.promptTokens, output: r.completionTokens }, // input/output 是 Langfuse 的 token 双栏口径
      input: r.error ? `失败：${r.error}` : `输出长度 ${r.conclusion?.length ?? 0} 字`,
      output: r.conclusion,
      metadata: { ok: r.ok, elapsedMs: r.elapsedMs, promptTokens: r.promptTokens, completionTokens: r.completionTokens },
    },
    {
      asType: 'generation',
      parentSpanContext: handle.root.otelSpan.spanContext(), // 显式串到 root——产线 spawn 是独立 await，不赌隐式上下文传播
    },
  )
  gen.end()
}

// 零成本事件（门检/熔断/短路）——Langfuse 的 event 类型自动 end，正好装免费编排信息
export function event(handle: RunHandle | null, role: string, kind: string, verdict?: string): void {
  if (!handle) return
  startObservation(`${kind} ${role}`, { statusMessage: verdict, metadata: { eventKind: kind } }, { asType: 'event', parentSpanContext: handle.root.otelSpan.spanContext() })
}

// 收尾：root.end() + 强刷到云端。fire-and-forget——不阻塞产线返回；失败只 log 不吞产线结果
export function finish(handle: RunHandle | null): void {
  if (!handle) return
  handle.root.end()
  processor!
    .forceFlush()
    .then(() => console.log('  [账] Langfuse trace 已刷到云端'))
    .catch((e) => console.log(`  [账] Langfuse 刷新失败：${(e as Error).message}`))
}

// 复用产线的 SpawnResult 形状（不引 spawn.ts 避免连带依赖；只取要的字段）
interface SpawnResult {
  ok: boolean
  conclusion?: string
  promptTokens: number
  completionTokens: number
  elapsedMs: number
  model?: string
  error?: string
}