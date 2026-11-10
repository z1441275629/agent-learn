// 模块 16 总控·路由入口：多步任务 → plan（planner-executor）；写技术博客 → composite 编排；
// 其余走单 agent。规则触发（零 token，不依赖模型自觉——沿用技能触发自动加载的教训）。
export type RouteMode = 'plan' | 'composite' | 'normal'

// 问句先拦：关于博客的提问不是写作指令（防「写博客怎么开始」「怎样写博客」误触发编排）
const QUESTION_MARKERS = /(怎么|怎样|如何|为什么|吗|？|\?|是什么)/
// 写博客类触发：写/生成/出 … 博客/技术文章/文章（或博客/技术文章 … 写/生成）。
// 间隔 .{0,25}：主题名（如「funciton calling」）会显著拉长 写→博客 的距离，15 太紧会漏触发
// （11-10 实测「写一篇关于funciton calling的博客」间隔 21 字符被 .{0,15} 漏掉，走了单 agent）
const COMPOSITE_TRIGGERS = /(写|生成|出).{0,25}(博客|技术文章|文章)|(博客|技术文章).{0,25}(写|生成)/

// 多步任务预筛（模块16 第二层 planner-executor）：≥2 个去重动作词 且 命中连接词 → plan。
// 判定在 composite 之前——「复盘并写博客」两类触发都命中时多步优先；「写一篇关于复盘的博客」
// 有 复盘+博客 两个动作词但无连接词，不进 plan 照走 composite（防把单意图误拦成多步）
const PLAN_CONNECTORS = /(并|然后|再|之后|接着|同时)/
const PLAN_ACTIONS = /(复盘|日报|博客|技术文章|文章|笔记|知识库|简报|总结)/g

export function routeMessage(text: string): RouteMode {
  if (QUESTION_MARKERS.test(text)) return 'normal'
  const actions = new Set(text.match(PLAN_ACTIONS) ?? [])
  if (actions.size >= 2 && PLAN_CONNECTORS.test(text)) return 'plan'
  return COMPOSITE_TRIGGERS.test(text) ? 'composite' : 'normal'
}
