// 个人 Agent 工作台 · 模块 13：AI 识别引擎（视觉 LLM 做 OCR）——与本地 tesseract 并存的第二路线
//
// 为什么要两条路线并存：模块 13 的对照作业就是「同图同场景，本地引擎 vs 视觉 LLM」。
// 差异是有结构的，不是谁替代谁：
//   本地 tesseract：字符级准、带坐标、免费离线；对花体/低对比/竖排/复杂版式弱
//   视觉 LLM：版式理解强、能顺手修整（去页眉页脚、合并断行）；但可能编字、不给可靠坐标、按图计费
// 所以接口统一成 OcrResult：AI 引擎 bbox/confidence 缺省（不伪造），UI 自动降级（无坐标就不做高亮）。
//
// 配置统一走 09-harness/llm.ts（「LLM 客户端唯一事实源」）：
//   LLM_VISION_BASE_URL / LLM_VISION_MODEL / LLM_VISION_API_KEY
//   缺省沿备用档（GLM 视觉）→ 主档回落，模型默认 glm-4.5v。
//
// 注意：思考开关按 LLM_THINKING_STYLE 走（PITFALLS #37：reasoning_effort 在 ARK 端点是死参数，
// thinking:{type:'disabled'} 才真生效）。OCR 是浅任务，不付思考预算。
import type OpenAI from 'openai'
import { z } from 'zod'
import { THINKING_STYLE, visionClient, VISION_MODEL } from '../09-harness/llm.ts'
import type { OcrResult } from './ocr.ts'

// 没配视觉档时只让 AI 路线失败，本地路线照常可用（绝不能因 AI 配置缺失把整个工具打死）
function getClient(): OpenAI {
	if (!visionClient) throw new Error('AI 识别未配置：LLM_VISION_MODEL / LLM_VISION_API_KEY（缺省回落备用档）')
	return visionClient
}

const RespSchema = z.object({
	// 宽容两种常见形状：[{"text": "..."}] 或 ["..."]——模型不总是听话，能接住就不必重试
	lines: z.array(z.union([z.string(), z.object({ text: z.string() })])),
})

/** 解析模型输出（纯函数，探针零成本覆盖）：剥 ```json 围栏、取最外层 JSON、两种行形状归一 */
export function parseVisionLines(raw: string): string[] {
	const l = raw.indexOf('{')
	const r = raw.lastIndexOf('}')
	if (l < 0 || r <= l) throw new Error('模型没返回 JSON')
	const parsed = RespSchema.parse(JSON.parse(raw.slice(l, r + 1)))
	return parsed.lines
		.map((x) => (typeof x === 'string' ? x : x.text))
		.map((t) => t.trim())
		.filter((t) => t.length > 0)
}

const SYSTEM = `你是 OCR 引擎。把图片中所有可见文字按从上到下的顺序逐行输出。
规则：
- 保持原始语言，不要翻译、不要总结、不要解释、不要补充图中没有的内容。
- 一行只输出该行文字本身；不要合并不同行，不要输出坐标。
- 严格只输出 JSON：{"lines":[{"text":"<第一行>"},{"text":"<第二行>"}]}`

function thinkingParam(): Record<string, unknown> {
	if (THINKING_STYLE === 'openapi') return { thinking: { type: 'disabled' } }
	if (THINKING_STYLE === 'bool') return { thinking: false }
	return {}
}

export async function recognizeWithAI(image: Buffer, mime = 'image/png'): Promise<OcrResult> {
	const t0 = Date.now()
	const dataUrl = `data:${mime};base64,${image.toString('base64')}`
	let lastErr = ''
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const res = await getClient().chat.completions.create({
				model: VISION_MODEL,
				messages: [
					{ role: 'system', content: SYSTEM },
					{
						role: 'user',
						content: [
							{ type: 'image_url', image_url: { url: dataUrl } },
							// 第二次尝试加重「只输出 JSON」——第一次常带解释文字或围栏
							{ type: 'text', text: attempt === 0 ? '识别并输出 JSON。' : '只输出 JSON，不要任何解释或代码围栏。' },
						],
					},
				],
				temperature: 0,
				max_tokens: 3000,
				...thinkingParam(),
			} as any)
			const raw = res.choices[0]?.message?.content ?? ''
			const texts = parseVisionLines(raw)
			if (texts.length === 0) throw new Error('模型返回 0 行')
			return {
				engine: 'ai',
				text: texts.join('\n'),
				lines: texts.map((text, id) => ({ id, text })),
				elapsedMs: Date.now() - t0,
				usage: res.usage ?? null, // 完整对象（prompt/completion/total + cached/reasoning 明细），不压成一个数
			}
		} catch (err: any) {
			lastErr = String(err?.message ?? err).slice(0, 300)
		}
	}
	// 502：上游模型挂了/配额撞墙——不是本服务的 500，UI 据此提示「切回本地引擎」
	throw Object.assign(new Error(`AI 识别失败：${lastErr}`), { code: 502 })
}
