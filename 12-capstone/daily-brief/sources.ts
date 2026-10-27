// 模块 12 毕业项目：直连源抓取层（B 路线：纯 API 直连，不碰网页爬虫）
//
// 调研实测（2026-10-27，curl 实打非文档推断）：HN Algolia 200/2.6s、GitHub API 200/0.9s、
// arxiv 200/6.6s（慢，首版不进）；量子位 403、机器之心 RSS 302 跳产品页已死——
// 网页源全军覆没不是巧合：HTML 是给人看的，API/结构化数据才是 agent 的口粮。
//
// 复用对照：
//   单源失败降级继续（Promise.allSettled）= 11 reliability 的思想简化版——产线不因一个源死掉
//   超时 10s + fail-fast 错误信息带 URL = 09 llm.ts 的「缺配置报清楚缺哪个」同款纪律
export interface RawItem {
	title: string
	url: string
	source: 'hn' | 'github'
	meta: string // 一行元信息（points/stars/时间/描述）——researcher 筛选的线索
}

async function fetchJSON(url: string, init?: RequestInit): Promise<any> {
	const res = await fetch(url, { signal: AbortSignal.timeout(10_000), ...init })
	if (!res.ok) throw new Error(`HTTP ${res.status} <- ${url.slice(0, 80)}`)
	return res.json()
}

// HN Algolia：按时间倒序全文检索（AI 圈情报密度最高的英文源），points>2 滤噪
export async function fetchHN(query: string, hours = 48): Promise<RawItem[]> {
	const since = Math.floor(Date.now() / 1000) - hours * 3600
	const url =
		`https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(query)}` +
		`&tags=story&numericFilters=created_at_i>${since},points>2&hitsPerPage=30`
	const j = await fetchJSON(url)
	return (j.hits ?? [])
		.filter((h: any) => h.title && h.url)
		.map((h: any) => ({
			title: h.title,
			url: h.url,
			source: 'hn' as const,
			meta: `HN ${h.points}分/${h.num_comments ?? 0}评 · ${new Date(h.created_at).toLocaleDateString('zh-CN')}`,
		}))
}

// GitHub：近 N 天新建仓库按星排——「什么在起飞」的信号源。
// 匿名限流 60 req/h（每天 4 发够用）；可选 GITHUB_TOKEN（.env）提到 5000/h
export async function fetchGitHub(query: string, days = 7): Promise<RawItem[]> {
	const since = new Date(Date.now() - days * 86400e3).toISOString().slice(0, 10)
	const url =
		`https://api.github.com/search/repositories?q=${encodeURIComponent(query)}+created:>${since}` +
		`&sort=stars&order=desc&per_page=10`
	const headers: Record<string, string> = { 'User-Agent': 'ai-agent-lab-capstone/1.0' } // GitHub API 无 UA 直接 403
	if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
	const j = await fetchJSON(url, { headers })
	return (j.items ?? []).map((r: any) => ({
		title: r.full_name,
		url: r.html_url,
		source: 'github' as const,
		meta: `GitHub ★${r.stargazers_count} · ${(r.description ?? '').slice(0, 100)}`,
	}))
}

// 抓一主题的全部源：并行 + 单源失败降级（错误带回台账，产线照跑）
export async function fetchTopic(hnQuery: string, githubQuery: string) {
	const [hn, gh] = await Promise.allSettled([fetchHN(hnQuery), fetchGitHub(githubQuery)])
	return {
		items: [...(hn.status === 'fulfilled' ? hn.value : []), ...(gh.status === 'fulfilled' ? gh.value : [])],
		errors: [hn, gh].filter((r) => r.status === 'rejected').map((r) => String((r as PromiseRejectedResult).reason)),
	}
}
