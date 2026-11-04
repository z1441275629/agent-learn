// 会话消息层：存储里的消息 → OpenAI 兼容请求消息
//
// 两条关键规则（写在唯一的构建函数里，探针零成本覆盖）：
//   ① 图片只随「最近一条 user 消息」发送：聊天 API 无状态，历史图每轮都重新计费
//      （一张 1080p 截图 2~3k tokens，十轮就是两三万）。旧图降级成一行文字占位，
//      而且这里连文件都不读——省略是零 I/O。
//   ② 失败的 assistant 消息（error 非空）留在界面给人看，但不进下一轮上下文。
//
// 图片二进制由调用方注入 loadImage（core/sessions 的 readImage）——这一层不碰存储路径。

export type ChatUsage = any

export interface StoredImageRef {
	file: string
	name: string
}

export interface StoredMessageLike {
	role: 'user' | 'assistant'
	text: string
	images: StoredImageRef[]
	error?: string
}

export type ImageLoader = (file: string) => Promise<{ mime: string; data: Buffer } | null>

export interface BuildOptions {
	elideOldImages?: boolean
	loadImage: ImageLoader
}

export async function buildApiMessages(
	messages: StoredMessageLike[],
	{ elideOldImages = true, loadImage }: BuildOptions,
): Promise<any[]> {
	const lastUser = messages.map((m) => m.role).lastIndexOf('user')
	const out: any[] = []
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i]
		if (m.role === 'assistant') {
			if (!m.error) out.push({ role: 'assistant', content: m.text })
			continue
		}
		if (m.images.length === 0) {
			out.push({ role: 'user', content: m.text })
			continue
		}
		const parts: any[] = []
		if (m.text) parts.push({ type: 'text', text: m.text })
		const elide = elideOldImages && i !== lastUser
		for (const image of m.images) {
			if (elide) {
				// 不读文件：省略必须零 I/O
				parts.push({ type: 'text', text: `[图片 ${image.name} 已省略——仅最近一轮保留图片]` })
				continue
			}
			const loaded = await loadImage(image.file)
			if (!loaded) continue // 文件丢了就跳过这张图，不让整轮对话失败
			parts.push({
				type: 'image_url',
				image_url: { url: `data:${loaded.mime};base64,${loaded.data.toString('base64')}` },
			})
		}
		out.push({ role: 'user', content: parts })
	}
	return out
}

/** 会话标题：第一条可读文本的前 24 字；纯图片会话给个兜底名 */
export function deriveTitle(text: string, hasImages: boolean): string {
	const line = text
		.split('\n')
		.map((l) => l.trim())
		.find((l) => l && !l.startsWith('附件 ')) ?? ''
	const clean = line.replace(/[`#*_>]/g, '').trim()
	if (clean) return clean.slice(0, 24) + (clean.length > 24 ? '…' : '')
	return hasImages ? '图片对话' : '新对话'
}
