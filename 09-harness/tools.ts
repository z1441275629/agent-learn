// 模块 08：工具注册表 —— 内置工具集中定义
// name -> { description, parameters, impl, maxResultTokens? } 集中管理。
// maxResultTokens：工具级截断配置（模块 06 武器①的口径）——大返回量的工具必须设，
// 小工具不设就不截。不设全局默认值，逼自己想清楚每个工具的返回量级。
// 记忆工具（read/write_memory）不在这里——它们定义在 memory.ts，由主流程启动时注册进来。
import type { ToolDef } from './type.ts'

export const registry = new Map<string, ToolDef>()

export function registerTool(name: string, def: ToolDef) {
	registry.set(name, def)
}

// 内置工具：天气（假数据，固定小雨，保证演示路径稳定）
registerTool('get_weather', {
	description: '查询某个城市当前的天气情况',
	parameters: {
		type: 'object',
		properties: { city: { type: 'string', description: '城市名，如：北京' } },
		required: ['city'],
	},
	impl: async (args) => JSON.stringify({ city: args.city, weather: '小雨', tempC: 18 }),
})

// 内置工具：算总价
registerTool('calculate_total', {
	description: '计算总价：数量 × 单价',
	parameters: {
		type: 'object',
		properties: {
			quantity: { type: 'number', description: '数量' },
			unit_price: { type: 'number', description: '单价（元）' },
		},
		required: ['quantity', 'unit_price'],
	},
	impl: async (args) => JSON.stringify({ total: args.quantity * args.unit_price }),
})

// 污染源工具：模拟真实 RAG/网页抓取的返回量级。
// 金笔记实验：第 51 条埋了决定性信息「家里已有 3 把伞」——它落在截断区里，
// 用来亲眼验证「截断省 token 但砍信息」：agent 大概率看不到它，照样建议买伞。
registerTool('search_notes', {
	description: '当用户提到笔记、个人记录、或需要引用用户过往记录时调用；输入搜索关键词，返回相关笔记列表',
	parameters: {
		type: 'object',
		properties: { query: { type: 'string', description: '搜索关键词' } },
		required: ['query'],
	},
	maxResultTokens: 300,
	impl: async (args) => JSON.stringify({ results: Array.from({ length: 100 }, (_, i) => (i === 50 ? '笔记51：重要！家里已经有 3 把伞了，不用再买' : `笔记${i + 1}：关于${args.query}的记录`)) }),
})

// 从注册表生成 API 的 tools 参数（新增工具零改动；调用前确保所有注册已完成）。
// only：工具面白名单（§5「工具面=能力面」的工具化）——undefined=全量（既有调用零改动）；
// []=零工具（纯文本 agent——写手/评审这类活不需要工具，挂着 search_notes 只会钓走注意力）；
// 数组=只暴露列名的。白名单写错名字大声报：静默少工具比报错难查（09「拒绝要大声」在工具面的投影）
export function buildToolsParam(only?: string[]): any[] {
	const tools: any[] = []
	for (const [key, value] of registry.entries()) {
		if (only && !only.includes(key)) continue
		tools.push({ type: 'function', function: { name: key, description: value.description, parameters: value.parameters } })
	}
	if (only) {
		const unknown = only.filter((n) => !registry.has(n))
		if (unknown.length) console.warn(`⚠ 工具白名单含未注册名字（已忽略）：${unknown.join(', ')}`)
	}
	return tools
}
