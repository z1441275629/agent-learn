// 模块 12 毕业项目 v2：SourcePlugin 数据源注册表——「订阅什么源」从代码硬编码变成数据
//
// v1→v2 核心通用化：v1 只有 hn/github 两个写死的源；v2 注册表 + 订阅条目 sources 数组自由组合。
// 行业新闻的最大公约数是 RSS（财经/医疗/媒体几乎都有 feed）——rss 源一通，「别的行业的新闻」
// 从「每源写一个 fetcher」变成「订阅里填 URL」。
//
// 安全：rss 的 query 是任意 URL（用户输入→服务器替他发请求的唯一入口）——SSRF 全套防护见 safeFetch。
// 依赖 fast-xml-parser：手写 XML（CDATA/entity/namespace/RSS2+Atom 双形状）坑大于收益，纯函数解析器值得。
import dns from 'node:dns/promises'
import { XMLParser } from 'fast-xml-parser'

export interface RawItem {
	title: string
	url: string
	source: string // 来源标签（hn/github/arxiv/rss）
	meta: string // 一行元信息（points/stars/时间/描述）——researcher 筛选的线索
}

export type SourceType = 'hn' | 'github' | 'arxiv' | 'rss'
export interface SourceSpec {
	type: SourceType
	query: string // rss=URL；其余=检索词
}

// ---------- SSRF 防护：safeFetch（rss/arxiv 统一走；hn/github 目标域写死但走同一入口无坏处） ----------
// 防护四件：协议白名单 + DNS 解析 IP 私网黑名单 + 重定向手动逐跳重验（30x 跳内网=绕过）+ 超时/大小上限。
// 已知残余（DESIGN.md 威胁模型）：DNS rebinding（校验时公网、请求时内网）需 pin IP 才能完美防，原生 fetch
// 做不到——记录接受，不假装防住了。
const PRIVATE_V4 = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^0\./]
function isPrivateIp(ip: string): boolean {
	const bare = ip.split('%')[0] // IPv6 link-local 带 scope 后缀（fe80::1%eth0）
	if (bare.includes(':')) return bare === '::1' || /^f[cd][0-9a-f]{2}:/.test(bare) || /^fe[89ab]/.test(bare)
	return PRIVATE_V4.some((re) => re.test(bare))
}
async function assertPublicUrl(u: URL): Promise<void> {
	if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`SSRF 防护：只允许 http/https（收到 ${u.protocol}）`)
	const hosts = await dns.lookup(u.hostname, { all: true }).catch(() => {
		throw new Error(`DNS 解析失败：${u.hostname}`)
	})
	for (const { address } of hosts) {
		if (isPrivateIp(address)) throw new Error(`SSRF 防护：${u.hostname} 解析到私网/环回地址 ${address}，拒绝`)
	}
}
const MAX_BODY = 2 * 1024 * 1024
async function safeFetch(input: URL): Promise<string> {
	let url = input
	for (let hop = 0; hop <= 5; hop++) {
		await assertPublicUrl(url)
		const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
		const loc = res.headers.get('location')
		if (res.status >= 300 && res.status < 400 && loc) {
			url = new URL(loc, url) // 相对跳转按当前 URL 解析
			continue // 每跳重新过 assertPublicUrl——重定向是 SSRF 绕过的经典载体
		}
		if (!res.ok) throw new Error(`HTTP ${res.status} <- ${url.toString().slice(0, 80)}`)
		if (!res.body) throw new Error('空响应体')
		// 流式读 + 大小上限：Content-Length 可信度低，读的时候数
		let size = 0
		const chunks: Buffer[] = []
		for await (const chunk of res.body) {
			size += chunk.length
			if (size > MAX_BODY) throw new Error('响应超过 2MB 上限')
			chunks.push(Buffer.from(chunk))
		}
		return Buffer.concat(chunks).toString('utf8')
	}
	throw new Error('重定向超过 5 跳')
}

// ---------- 专用源（hn/github 从 v1 原样搬——5 发真跑验证过的形状） ----------
async function fetchJSON(url: string, init?: RequestInit): Promise<any> {
	const res = await fetch(url, { signal: AbortSignal.timeout(10_000), ...init })
	if (!res.ok) throw new Error(`HTTP ${res.status} <- ${url.slice(0, 80)}`)
	return res.json()
}

// HN Algolia：按时间倒序全文检索（AI 圈情报密度最高的英文源），points>2 滤噪
async function fetchHN(query: string): Promise<RawItem[]> {
	const since = Math.floor(Date.now() / 1000) - 48 * 3600
	const url =
		`https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(query)}` +
		`&tags=story&numericFilters=created_at_i>${since},points>2&hitsPerPage=30`
	const j = await fetchJSON(url)
	return (j.hits ?? [])
		.filter((h: any) => h.title && h.url)
		.map((h: any) => ({
			title: h.title,
			url: h.url,
			source: 'hn',
			meta: `HN ${h.points}分/${h.num_comments ?? 0}评 · ${new Date(h.created_at).toLocaleDateString('zh-CN')}`,
		}))
}

// GitHub：近 7 天新建仓库按星排——「什么在起飞」的信号源。匿名 60 req/h，配 GITHUB_TOKEN 提到 5000/h
async function fetchGitHub(query: string): Promise<RawItem[]> {
	const since = new Date(Date.now() - 7 * 86400e3).toISOString().slice(0, 10)
	const url =
		`https://api.github.com/search/repositories?q=${encodeURIComponent(query)}+created:>${since}` +
		`&sort=stars&order=desc&per_page=10`
	const headers: Record<string, string> = { 'User-Agent': 'ai-agent-lab-capstone/2.0' } // GitHub API 无 UA 直接 403
	if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
	const j = await fetchJSON(url, { headers })
	return (j.items ?? []).map((r: any) => ({
		title: r.full_name,
		url: r.html_url,
		source: 'github',
		meta: `GitHub ★${r.stargazers_count} · ${(r.description ?? '').slice(0, 100)}`,
	}))
}

// ---------- XML 源：RSS/Atom 通用 + arxiv（Atom） ----------
const xp = new XMLParser({ ignoreAttributes: false })
// fast-xml-parser 的产出可能是 string / {_text} / {_cdata}——统一拍平
const text = (v: unknown): string => {
	if (typeof v === 'string' || typeof v === 'number') return String(v).trim()
	if (v && typeof v === 'object') {
		const o = v as any
		return text(o._text ?? o._cdata ?? o['#text'] ?? '')
	}
	return ''
}
// RSS 2.0 与 Atom 双形状归一：item[].title/link/description 与 entry[].title/link[@_href]/summary
// （导出供探针：纯函数零副作用，样例 XML 直接喂）
export function parseFeed(xml: string): RawItem[] {
	const j: any = xp.parse(xml)
	const items: any[] = [].concat(j?.rss?.channel?.item ?? j?.feed?.entry ?? [])
	return items
		.slice(0, 30)
		.map((it) => {
			// Atom 的 link 是数组 [{@_rel:'alternate',@_href},...]，RSS 是直串
			const url =
				typeof it.link === 'string'
					? it.link
					: text([].concat(it.link ?? []).find((l: any) => !l['@_rel'] || l['@_rel'] === 'alternate')?.['@_href'])
			return { title: text(it.title), url, source: 'rss', meta: text(it.description ?? it.summary ?? '').slice(0, 200) }
		})
		.filter((i) => i.title && /^https?:\/\//.test(i.url))
}

async function fetchRSS(url: string): Promise<RawItem[]> {
	return parseFeed(await safeFetch(new URL(url)))
}

// arxiv：检索式 API（Atom XML），按提交时间倒序——论文圈的「最近在出什么」
async function fetchArxiv(query: string): Promise<RawItem[]> {
	const url =
		`https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}` +
		`&sortBy=submittedDate&sortOrder=descending&max_results=20`
	const xml = await safeFetch(new URL(url))
	const j: any = xp.parse(xml)
	const entries: any[] = [].concat(j?.feed?.entry ?? [])
	return entries
		.map((e) => ({
			title: text(e.title).replace(/\s+/g, ' '),
			url: text(e.id), // arxiv entry.id 就是论文页 URL
			source: 'arxiv',
			meta: `arXiv ${text(e.published).slice(0, 10)} · ${text(e.summary).slice(0, 150)}`,
		}))
		.filter((i) => i.title && /^https?:\/\//.test(i.url))
}

// ---------- 注册表 + 抓取去重 ----------
export const SOURCES: Record<SourceType, { label: string; fetch: (query: string) => Promise<RawItem[]> }> = {
	hn: { label: 'Hacker News', fetch: fetchHN },
	github: { label: 'GitHub', fetch: fetchGitHub },
	arxiv: { label: 'arXiv', fetch: fetchArxiv },
	rss: { label: 'RSS/Atom', fetch: fetchRSS },
}

// run 级抓取缓存：N 人同订一个 (type,query) 只打一次外部 API（LLM 仍按人跑——focus 不同）。
// 失败不缓存（清掉让下次重试），成功缓存 Promise 本身——同 key 的并发请求共享同一个在途 Promise。
const fetchCache = new Map<string, Promise<RawItem[]>>()
export function fetchSourceCached(type: SourceType, query: string): Promise<RawItem[]> {
	const key = `${type}::${query}`
	let p = fetchCache.get(key)
	if (!p) {
		p = SOURCES[type].fetch(query).catch((err) => {
			fetchCache.delete(key)
			throw err
		})
		fetchCache.set(key, p)
	}
	return p
}

// 一主题全部源：并行 + 单源失败降级（v1 语义照搬——产线不因一个源死掉）
export async function fetchTopicSources(specs: SourceSpec[]) {
	const rs = await Promise.allSettled(specs.map((s) => fetchSourceCached(s.type, s.query)))
	return {
		items: rs.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])),
		errors: rs.filter((r) => r.status === 'rejected').map((r) => String((r as PromiseRejectedResult).reason)),
	}
}
