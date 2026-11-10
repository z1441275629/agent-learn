// 模块 16 总控·路由入口：自动识别「写技术博客」意图 → composite 编排；其余走单 agent。
// 规则触发（零 token，不依赖模型自觉——沿用技能触发自动加载的教训）；结构留好扩展位
// （planner/cron 等模式下一层接，RouteMode 扩枚举即可）。
export type RouteMode = 'composite' | 'normal'

// 问句先拦：关于博客的提问不是写作指令（防「写博客怎么开始」「怎样写博客」误触发编排）
const QUESTION_MARKERS = /(怎么|怎样|如何|为什么|吗|？|\?|是什么)/
// 写博客类触发：写/生成/出 … 博客/技术文章/文章（或博客/技术文章 … 写/生成）。
// 间隔 .{0,25}：主题名（如「funciton calling」）会显著拉长 写→博客 的距离，15 太紧会漏触发
// （11-10 实测「写一篇关于funciton calling的博客」间隔 21 字符被 .{0,15} 漏掉，走了单 agent）
const COMPOSITE_TRIGGERS = /(写|生成|出).{0,25}(博客|技术文章|文章)|(博客|技术文章).{0,25}(写|生成)/

export function routeMessage(text: string): RouteMode {
  if (QUESTION_MARKERS.test(text)) return 'normal'
  return COMPOSITE_TRIGGERS.test(text) ? 'composite' : 'normal'
}
