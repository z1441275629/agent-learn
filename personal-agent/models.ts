// 个人 Agent 工作台 · 模型目录 + 思考强度（UI 下拉框的数据源）
//
// 目录从 llm.ts 的四个档位生成（主/小/备用/视觉），同名模型去重——当前 .env 里主档和小档
// 都是 deepseek-v4-flash，去重后只出现一次。换模型只改 .env，这里零改动。
// vision 标记决定「带图请求」能不能发给它；将来主模型换成多模态的，把 vision: true 改这一处即可。
import type OpenAI from 'openai'
import {
	client,
	lightClient,
	backupClient,
	visionClient,
	MODEL,
	LIGHT_MODEL,
	BACKUP_MODEL,
	VISION_MODEL,
	THINKING_STYLE,
} from '../09-harness/llm.ts'

export interface ModelEntry {
	id: string
	label: string
	model: string
	vision: boolean
	client: OpenAI
}

const all: ModelEntry[] = [
	{ id: 'main', label: '主模型', model: MODEL, vision: false, client },
	...(lightClient && LIGHT_MODEL ? [{ id: 'light', label: '小档', model: LIGHT_MODEL, vision: false, client: lightClient }] : []),
	...(backupClient && BACKUP_MODEL ? [{ id: 'backup', label: '备用档', model: BACKUP_MODEL, vision: false, client: backupClient }] : []),
	...(visionClient && VISION_MODEL ? [{ id: 'vision', label: '视觉', model: VISION_MODEL, vision: true, client: visionClient }] : []),
]

// 按模型名去重（同模型不同档位没有选择意义）
export const MODELS: ModelEntry[] = all.filter((m, i) => all.findIndex((x) => x.model === m.model) === i)

export const DEFAULT_MODEL_ID = MODELS[0]?.id ?? 'main'

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high'
export const THINKING_LEVELS: ThinkingLevel[] = ['off', 'low', 'medium', 'high']

/**
 * 思考强度 → 平台参数。
 * 已知边界（PITFALLS #37）：reasoning_effort 在火山 ARK 端点是死参数，只有 thinking 开关真生效——
 * 所以在 ARK 上 low/medium/high 实际等价于「开」，参数照传（支持它的平台就能真分级）。
 */
export function thinkingParams(level: string): Record<string, unknown> {
	if (THINKING_STYLE === 'none') return {}
	const on = THINKING_LEVELS.includes(level as ThinkingLevel) && level !== 'off'
	if (THINKING_STYLE === 'bool') return { thinking: on }
	return on ? { thinking: { type: 'enabled' }, reasoning_effort: level } : { thinking: { type: 'disabled' } }
}
