// 个人 Agent 工作台 · 对话消息层
//
// 前端消息形状（带图片/附件的 content 数组）→ OpenAI 兼容消息。两条关键规则：
//   ① 图片只随「最近一条 user 消息」发送：聊天 API 无状态，历史里的图每轮都重新计费
//      （一张 1080p 截图 2~3k tokens，十轮就是两三万）。旧图替换成一行文字占位，成本可控。
//   ② 图片必须是 data:image/... 内联——不接受 http URL（内联意味着客户端已读过文件，
//      也避免服务端替用户去抓任意地址）。
//
// 纯函数（normalizeMessages / lastUserHasImages）导出给探针，零成本覆盖降级规则。

export type ChatRole = 'user' | 'assistant'
export type ContentPart =
	| { type: 'text'; text: string }
	| { type: 'image'; dataUrl: string; name?: string }
export interface ChatMessage {
	role: ChatRole
	content: string | ContentPart[]
}

/** 完整 usage（服务商原样返回：prompt/completion/total + cached_tokens/reasoning_tokens 等明细）。
 *  形状随平台而异、且 SDK 的接口类型不带索引签名——这里不收窄，避免为了类型体操丢掉字段。 */
export type ChatUsage = any

const MAX_MESSAGES = 100

function assertMessages(messages: unknown): asserts messages is ChatMessage[] {
	if (!Array.isArray(messages) || messages.length === 0) throw Object.assign(new Error('messages 不能为空'), { code: 400 })
	if (messages.length > MAX_MESSAGES) throw Object.assign(new Error(`消息过多（上限 ${MAX_MESSAGES} 条）`), { code: 400 })
	for (const m of messages) {
		if (!m || (m.role !== 'user' && m.role !== 'assistant')) throw Object.assign(new Error('role 只能是 user/assistant'), { code: 400 })
		if (typeof m.content !== 'string' && !Array.isArray(m.content)) throw Object.assign(new Error('content 形状不对'), { code: 400 })
	}
}

/** 最近一条 user 消息里的图片（= 真正会被发送的图） */
export function lastUserHasImages(messages: ChatMessage[]): boolean {
	const lastUser = messages.map((m) => m.role).lastIndexOf('user')
	if (lastUser < 0) return false
	const c = messages[lastUser].content
	return Array.isArray(c) && c.some((p) => p.type === 'image')
}

export function normalizeMessages(messages: ChatMessage[], elideOldImages = true): any[] {
	assertMessages(messages)
	const lastUser = messages.map((m) => m.role).lastIndexOf('user')
	return messages.map((m, i) => {
		if (typeof m.content === 'string') return { role: m.role, content: m.content }
		const parts: any[] = []
		for (const p of m.content) {
			if (p.type === 'image') {
				if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(p.dataUrl)) {
					throw Object.assign(new Error('图片必须是 data:image/...;base64 内联数据'), { code: 400 })
				}
				if (elideOldImages && i !== lastUser) {
					// 旧图降级成文字占位：模型仍知道「这里有过一张图」，但不再付图 token
					parts.push({ type: 'text', text: `[图片${p.name ? ` ${p.name}` : ''}已省略——仅最近一轮保留图片]` })
				} else {
					parts.push({ type: 'image_url', image_url: { url: p.dataUrl } })
				}
			} else if (typeof p.text === 'string' && p.text.trim()) {
				parts.push({ type: 'text', text: p.text })
			}
		}
		return { role: m.role, content: parts }
	})
}
