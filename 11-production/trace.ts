/*
模块 11 §3：手写最小 trace——把 [账] console.log 升级成结构化追踪（骨架——学习核心你来填）

现状：[账] 是 console.log（composite.ts chargeR/chargeW），跑完就没了。§8 那张六窗口流转图靠手抄。
目标：每次产线运行落盘一份 JSON（span 树），流转图/账本/token 聚合全从 trace 生成，不再手抄、不再改代码。

span 树模型——每次 spawn 一个 span，四要素全在 SpawnResult 手里：
  token（双栏）+ elapsedMs（spawn 每路都填）+ 结论摘要（conclusion 截断）+ verdict（门检/评审判据）
  零成本事件（门检/#parse/形状打回）不烧 token，也进树——它们是有价值的编排信息

本节 TODO：
  ① span 采集——composite.ts 的 chargeR/chargeW 处喂 trace.spawn(...)，产线 trace 落盘接上
  ② renderFlow 流转图——从 span 树生成 §8 那种「┃窗口/◆节点 + 账 + 交接流」文本图（回头债自动清）
  ③ 布局决策——树怎么组织：研究段⇄审校① 的嵌套修订、写作段⇄审校②,要画出「窗口每次是全新」那层语义
*/
import fs from 'node:fs/promises'
import path from 'node:path'

// ---------- span 模型 ----------
// token / elapsedMs / ok 是必填——由 chargeR/chargeW 喂的 SpawnResult 确定有（别让调用方漏填而不报错）
export interface Span {
  role: string // 阶段名：研究员首发 / 审校① / 研究员修订 / 写手首稿 / 审校② / 写手修订（修订类带序号：#1/#2——同角色多次靠它区分，renderFlow 才能还原六窗口实际结构）
  ok: boolean
  promptTokens: number
  completionTokens: number
  elapsedMs: number
  conclusion?: string // 结论摘要（截断）
  verdict?: 'pass' | 'fail' | 'skip' | `reject:${string}` // 门检/评审判据——零成本事件的落点
  event?: EventKind // 免费节点的分类（不烧 token 的编排事件）
  children?: Span[] // 子 span——仅当真有父子嵌套语义时用；修订复写是「平铺的新窗口」不是嵌套，别硬塞 children
}

// 零成本事件的分类——熔断/短路要带 openIssues 归因，图里画「为什么停」不是画「停了」
type EventKind = 'shape-gate' | 'parse' | 'melt' | 'short-circuit' | (string & {})
export interface TraceMeta {
  topic: string // 这次产线跑的是什么题目——排查「哪次运行」的命根子
  source: string // 素材摘要（前 80 字）——图起点画「素材」节点用；暴库不落全量，落摘要够判断
}

// ---------- 采集器 ----------
export class TraceCollector {
  readonly spans: Span[] = []
  readonly startMs = Date.now()
  private readonly meta: TraceMeta
  private readonly traceId: string // 落盘文件名用——缺了 save 会写出 undefined.json
  constructor(meta: TraceMeta) {
    this.meta = meta
    this.traceId = `run-${new Date().toISOString().replace(/[:.]/g, '-')}`
  }

  // 每次 spawn 记录一个 span（composite chargeR/chargeW 处调）——token/耗时/ok 必填，能省则不省
  spawn(span: Span) {
    this.spans.push(span)
  }

  // 零成本事件（门检打回 / 熔断 / 短路——不烧 token 的编排信息）；melt/short-circuit 要带归因 reason
  event(role: string, event: EventKind, verdict?: Span['verdict'], reason?: string) {
    this.spans.push({
      role,
      ok: true,
      promptTokens: 0,
      completionTokens: 0,
      elapsedMs: 0,
      event,
      verdict,
      ...(reason ? { conclusion: reason } : {}),
    })
  }

  // 从 this.spans 生成 §8 那种流转图文本。骨架预填图例，图体靠你的布局决策。
  renderFlow(): string {
    // agent 窗口判据：token 双栏 > 0（真金白银）。免费点（门检/熔断/短路）token 恒 0——这个判据不依赖角色枚举，事件/窗口顺序打乱也不误判
    const isWindow = (s: Span) => s.promptTokens + s.completionTokens > 0
    function renderSpans(list: Span[], level = 1) {
      const windowCount = list.filter(isWindow).length // 只数 agent 窗口——免费节点不占档位，X/N 才是「第几窗口」不是「第几条 span」
      const res: string[] = []
      let w = 0
      for (const span of list) {
        const { role, promptTokens, completionTokens, ok, conclusion, verdict, event } = span
        // §TODO③ 布局决策你来填：树怎么组织（研究段⇄审校①嵌套修订、写作段⇄审校②）。composite 当前是平铺不传 children，这里暂只平铺画
        if (isWindow(span)) {
          w++
          res.push(
            [
              `| ${w}/${windowCount} 窗口 ${role}`,
              `|    账：prompt: ${promptTokens} / completion: ${completionTokens}`,
              `|    状态：${ok ? '通过' : '失败'}`,
              `|    结论：${conclusion}`,
            ].join('\n'),
          )
        } else {
          // 免费节点按语义角色画（熔断就是熔断，不叫门检）——图里画「为什么停」不是画「停了」
          res.push([`| ◆ ${event}  ${role}`, `|    状态：${verdict}`].join('\n'))
        }
      }

      return res.map((line) => line) // 保留 children 递归的层空间留给 §TODO③
    }

    return [
      '图例：┃ agent 窗口（每一发都是真金白银）  ◆ 免费节点（纯函数/编排代码，token 为零）',
      '     │ 交接物流向',
      renderSpans(this.spans).join('\n'),
    ].join('\n')
  }

  // 落盘：traces 目录存 JSON（含头 meta）+ 流转图 txt
  async save(): Promise<string> {
    const dir = path.resolve(import.meta.dirname, 'traces')
    await fs.mkdir(dir, { recursive: true })
    const jsonPath = path.join(dir, `${this.traceId}.json`)
    const txtPath = path.join(dir, `${this.traceId}-flow.txt`)
    await fs.writeFile(
      jsonPath,
      JSON.stringify(
        {
          traceId: this.traceId,
          meta: this.meta,
          startMs: this.startMs,
          durationMs: Date.now() - this.startMs,
          spans: this.spans,
        },
        null,
        2,
      ),
    )
    await fs.writeFile(txtPath, this.renderFlow())
    return jsonPath
  }

  get id() {
    return this.traceId
  }
}
