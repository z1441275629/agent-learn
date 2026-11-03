// 个人 Agent 工作台 · 翻译（OCR 的第二步：文字 → 简体中文）
//
// 分工：OCR 本地做（确定性任务），翻译走文本 LLM（语言理解任务）。只翻「非中文行」——
// 中文行再翻一遍既费钱又容易把专有名词改坏。判断启发式：CJK 占比 < 30% 且有字母。
// 输出用 JSON 约束 + zod 校验 + 一次重试（结构化输出的老套路，daily-brief 同款纪律）。
import { z } from 'zod'
import { client, MODEL, THINKING_STYLE } from '../09-harness/llm.ts'
import type { OcrLine } from './ocr.ts'

const RespSchema = z.object({ items: z.array(z.object({ id: z.number(), zh: z.string() })) })

const CJK_RE = /[㐀-鿿＀-￯]/g
/** 需要翻译的行：CJK 占比低且有拉丁/其他字母（纯数字/符号行不翻） */
export function needsTranslation(text: string): boolean {
	const dense = text.replace(/\s/g, '')
	if (!dense) return false
	if (!/[A-Za-zЀ-ӿ぀-ヿ가-힯]/.test(text)) return false // 纯数字/符号/中文
	const cjk = (text.match(CJK_RE) ?? []).length / dense.length
	return cjk < 0.3
}

const SYSTEM = `你是截图文字的翻译助手。把用户给的每一行文字翻译成简体中文。
规则：
- 产品名、人名、代码标识符、URL、邮箱保持原样不译；必要时用「中文（原名）」格式。
- 已经是中文的行原样返回。
- 严格输出 JSON，不要任何其他文字：{"items":[{"id":<原 id>,"zh":"<译文>"}]}`

/** 逐行翻译；返回 id→译文。LLM 失败不阻塞 OCR（返回空 Map，UI 只显示原文） */
export async function translateLines(lines: OcrLine[]): Promise<{ map: Map<number, string>; error?: string }> {
	const need = lines.filter((l) => needsTranslation(l.text))
	if (need.length === 0) return { map: new Map() }
	const payload = JSON.stringify(need.map((l) => ({ id: l.id, text: l.text })))
	const map = new Map<number, string>()
	let lastErr = ''
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const res = await client.chat.completions.create({
				model: MODEL,
				messages: [
					{ role: 'system', content: SYSTEM },
					{ role: 'user', content: payload },
				],
				temperature: 0.1,
				max_tokens: 800,
				// 翻译是浅任务，不该付思考预算：默认 10s（517 推理 token）、reasoning_effort=low
				// 在本模型上无效（仍 500+），thinking 全关 2.1s 且专名稳（3 连测一致）。
				// 按仓库约定走 LLM_THINKING_STYLE 翻译层，换平台只改 .env。
				...(THINKING_STYLE === 'openapi'
					? { thinking: { type: 'disabled' } }
					: THINKING_STYLE === 'bool'
						? { thinking: false }
						: {}),
			} as any)
			const raw = res.choices[0]?.message?.content ?? ''
			const jsonText = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1) // 防模型包 ```json 围栏
			const parsed = RespSchema.parse(JSON.parse(jsonText))
			for (const it of parsed.items) if (need.some((l) => l.id === it.id)) map.set(it.id, it.zh.trim())
			return { map }
		} catch (err: any) {
			lastErr = String(err?.message ?? err).slice(0, 200)
		}
	}
	return { map, error: lastErr }
}
