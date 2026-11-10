// 模块 16 总控·路由入口：自动识别「写技术博客」意图 → composite 编排；其余走单 agent。
// 规则触发（零 token，不依赖模型自觉——沿用技能触发自动加载的教训）；结构留好扩展位
// （planner/cron 等模式下一层接，RouteMode 扩枚举即可）。
export type RouteMode = 'composite' | 'normal'

// 问句先拦：关于博客的提问不是写作指令（防「写博客怎么开始」误触发编排）
const QUESTION_MARKERS = /(怎么|如何|为什么|吗|？|\?|是什么)/
// 写博客类触发：写/生成/出 … 博客/技术文章/文章（或博客/技术文章 … 写/生成）
const COMPOSITE_TRIGGERS = /(写|生成|出).{0,15}(博客|技术文章|文章)|(博客|技术文章).{0,15}(写|生成)/

export function routeMessage(text: string): RouteMode {
  if (QUESTION_MARKERS.test(text)) return 'normal'
  return COMPOSITE_TRIGGERS.test(text) ? 'composite' : 'normal'
}
