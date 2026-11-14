// 简历 agent（P2 待建，建设顺序见设计稿 §5.7；builder check 后从 P3 提前到 P2——面试前最紧迫的交付物）
// 双路：上传旧简历（分析→前端→AI 应用重定位改写，diff 预览） / 无简历（四段式引导生成）
// PII 纪律：uploads/ 与产物目录 gitignore；简历链路不上传 LangSmith（局部关 tracing，方案实现期定）
export const STATUS = 'P2 待开放'
