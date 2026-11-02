// 模块 12 毕业项目 v2：预置话题库——「订阅」从「填源」变成「勾话题」
//
// 用户反馈：站在用户角度应该是选关注的话题，RSS 链接这些应该程序帮用户找。B 路线无搜索引擎，
// 「帮找」落地为运营者 curated 预置库：每个话题的源都配好。库里的 RSS 全部用与 pipeline 同
// 运行时的 Node fetch 实测过（拉得到 + fast-xml-parser 能解析出 items 才入库——36kr/zhihu
// 状态码 200 但返回反爬页 0 items，宁缺毋滥不入库；NYT/BBC 超时同样不入）。
// 自定义话题只填名字，autoSourcesFor 自动配 hn/github/arxiv 三个检索源（英文关键词效果好；
// 中文资讯走预置话题的 RSS）。
import type { SourceSpec } from './sources'

export interface TopicPreset {
	id: string
	name: string
	focus: string
	sources: SourceSpec[]
}

const rss = (url: string): SourceSpec => ({ type: 'rss', query: url })

export const TOPIC_PRESETS: TopicPreset[] = [
	{
		id: 'ai-agents',
		name: 'AI 与 Agent',
		focus: 'AI Agent 的最新进展：框架、产品、论文与社区讨论',
		sources: [
			{ type: 'hn', query: 'AI agent' },
			{ type: 'github', query: 'AI agent' },
			{ type: 'arxiv', query: 'AI agent' },
		],
	},
	{
		id: 'llm',
		name: '大语言模型',
		focus: 'LLM 的新模型、训练/推理技术与重要论文',
		sources: [
			{ type: 'hn', query: 'LLM' },
			{ type: 'arxiv', query: 'large language model' },
			{ type: 'github', query: 'LLM' },
		],
	},
	{
		id: 'frontend',
		name: '前端开发',
		focus: '前端框架、TypeScript 生态与工具链动态',
		sources: [
			{ type: 'hn', query: 'typescript' },
			{ type: 'github', query: 'typescript' },
			rss('https://sspai.com/feed'),
		],
	},
	{
		id: 'cn-tech',
		name: '中文科技快讯',
		focus: '中文科技圈的当日要闻与产品动态',
		sources: [
			rss('https://www.ithome.com/rss'),
			rss('https://www.ifanr.com/feed'),
			rss('https://www.geekpark.net/rss'),
		],
	},
	{
		id: 'en-tech',
		name: '英文科技深度',
		focus: '国际科技媒体的技术深读与行业分析（LLM 会翻译成中文）',
		sources: [
			rss('https://feeds.arstechnica.com/arstechnica/technology-lab'),
			rss('https://feeds.a.dj.com/rss/RSSWorldNews.xml'),
		],
	},
	{
		id: 'tools',
		name: '效率工具',
		focus: '提升效率的新工具、工作流与方法',
		sources: [
			rss('https://sspai.com/feed'),
			{ type: 'hn', query: 'productivity tool' },
			{ type: 'github', query: 'productivity' },
		],
	},
	{
		id: 'startup',
		name: '创业与产品',
		focus: '创业动态、产品发布与行业商业新闻',
		sources: [
			{ type: 'hn', query: 'startup' },
			rss('https://feeds.a.dj.com/rss/RSSWorldNews.xml'),
		],
	},
	{
		id: 'opensource',
		name: '开源新项目',
		focus: '近一周新起的开源项目与社区在造什么',
		sources: [
			{ type: 'hn', query: 'Show HN' },
			{ type: 'github', query: 'open source' },
		],
	},
]

// 自定义话题自动配源：三个检索源直配话题名——用户不需要知道什么是「源」
export function autoSourcesFor(name: string): SourceSpec[] {
	return [
		{ type: 'hn', query: name },
		{ type: 'github', query: name },
		{ type: 'arxiv', query: name },
	]
}
