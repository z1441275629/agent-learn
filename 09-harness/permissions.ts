/*
模块 09 §1：权限系统（骨架——核心管线你来填）

定位：harness 的第一道闸。所有工具调用在执行前先过这里——
- allow   读类，免批直接跑
- confirm 写类，human-in-the-loop 确认（TTY 问答；无头模式见坑②）
- deny    敏感类，直接拒（黑名单兜底——allowlist 挡不住的组合命令靠它）

规则语法（对照 Claude Code 的 permissions 设计，验收时逐项对上）：
  "tool"            工具级：如 "get_weather"
  "tool(参数模式)"   参数级（§2 的升级目标）：如 "write_memory(name=memories/*)"、
                    "run_shell(npm *)"——先做工具级，参数级等沙箱一起上

判定管线（顺序就是语义）：
  deny 命中 → deny（拒绝优先：白名单是可以被构造性输入绕过的，黑名单是底线）
  → allow 命中 → allow
  → confirm 命中 / 未列出 → confirm 流程（未列出默认 confirm——
    默认 deny 太严会训练人无脑点允许，默认 allow 形同虚设，confirm 是安全默认；
    PERMISSION_MODE=auto 时本档自动放行，run_shell 除外——见下方模式层注释）

两个坑预告（踩实了记 PITFALLS）：
- 组合命令绕过：白名单放行 "run_shell(npm *)"，模型来一句 "npm test && rm -rf /"——
  字符串前缀匹配对组合命令是纸糊的（07 #7 的 includes 逃逸同族，这次更凶）
- confirm 在无人值守时没人答：planner 每步一个子 agent，stdin 不在——无头模式（!isTTY）
  必须有显式默认（拒），静默放行 = 权限系统形同虚设
*/
import fs from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline/promises'

export type Verdict = 'allow' | 'confirm' | 'deny'

interface PermissionConfig {
	mode?: 'default' | 'auto' // 权限模式（用户配置层，优先于环境变量——见模式层注释）
	allow: string[]
	confirm: string[]
	deny: string[]
}

const CONFIG_PATH = path.resolve(import.meta.dirname, 'permissions.json')

// 合法规则格式（matchRule 同款正则——校验和匹配必须同源，两套正则迟早走岔）
// 注意 [a-z_]+ 外面的捕获括号：matchRule 靠解构 `[, name, argString]` 取组，
// 括号一丢 name 就成 undefined、全部规则失配——且 .test() 校验不受影响，坏得无声无息（今天踩实了）
// /i：规则里大小写宽容（GET_WEATHER 也认）——有意的宽容，省得配置大小写打架
const RULE_PATTERN = /^([a-z_]+)(?:\((.+)?\))?$/i

// 启动时读一次，改规则重启生效（热重载不值得做——权限配置本来就该低频变更+高确定性）
export async function loadPermissions(): Promise<PermissionConfig> {
	try {
		const config: PermissionConfig = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'))
		// 拼错的 mode 和拼错的规则同罪：以为在 auto、实际全走问——启动就炸，不运行时静默失效
		if (config.mode !== undefined && !['default', 'auto'].includes(config.mode)) {
			throw new Error(`mode 取值非法: ${config.mode}（只认 default/auto）`)
		}
		// 逐条校验：拼错的规则永不命中，写 deny 的人以为自己拒了实际没拒——
		// 「永不命中的规则」和 cron「永不触发的表达式」同罪，启动就炸，不运行时静默失效
		const bad = [...config.allow, ...config.confirm, ...config.deny].filter((r) => !RULE_PATTERN.test(r))
		if (bad.length) throw new Error(`规则格式非法: ${bad.join(' | ')}`)
		// 生效模式大声报一次（带来源）：静默的 auto 比没有 auto 危险——人以为闸还在
		if ((config.mode ?? ENV_MODE) === 'auto') {
			console.warn(`⚠ 权限模式 auto 生效（来源：${config.mode ? 'permissions.json' : '环境变量 PERMISSION_MODE'}）：confirm 档不再人工确认；run_shell 仍走确认。deny / pre-hook / 沙箱照常生效`)
		}
		return config
	} catch (err: any) {
		// 配置缺失/损坏/含非法规则 = 全部走 confirm（fail-safe：宁可多问一句，不可静默放行）
		// 但必须大声报——静默降级到全量确认，人会误以为配置生效了
		console.error(`⚠ 权限配置加载失败，本次所有工具走人工确认：${err?.message}`)
		throw err
	}
}

// 规则匹配：一条规则是否命中 (toolName, args)
// 工具级 "tool" 比名即中；参数级 "tool(参数模式)" 是「形状比对」：glob 模式 × 实参值。
// 与沙箱的分工（别再混）：权限层只看形状——echo * 对 "echo hi && del x" 形状确实匹配，
// 该放行；内容有毒（第二段的 del）是 sandbox.ts 的 inspectCommand 在 impl 里拦。
// 权限层复用内容分析 = 配置语义被偷换 + 两层干一件事，防线反而变薄
function matchRule(rule: string, toolName: string, args: any): boolean {
	// 格式校验已在 loadPermissions 做过（同源 RULE_PATTERN），这里只管匹配
	const parsedRule = RULE_PATTERN.exec(rule)
	if (!parsedRule) return false
	const [, name, argString] = parsedRule
	if (name !== toolName) return false
	if (!argString) return true // 工具级规则，命中
	// 参数级：glob（* = 任意串）→ 锚定正则，对字符串参数值任一命中即命中。
	// echo * → ^echo .*$：命中 "echo hi"，不命中 "node -v"——args 才是比对的另一半，
	// 模式串自己（argString）跟安全问题无关，永远不要拿它去过沙箱
	const globToRegex = (glob: string) => new RegExp('^' + glob.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')
	const re = globToRegex(argString.trim())
	return Object.values(args ?? {})
		.filter((v) => typeof v === 'string')
		.some((v) => re.test(v))
}

// human-in-the-loop：TTY 上问一句，返回用户批没批
// 金笔记：这是整个 harness 唯一「人的声音能进来」的地方——问题文案要让人能做判断：
//   打出 工具名 + 完整参数（截断的参数让人批准的是盲盒），别打「允许吗？(y/n)」
async function askHuman(toolName: string, args: any): Promise<boolean> {
	// 无头（planner 子 agent / 管道 / 后台）：没人能回答，默认拒——但必须大声报，
	// 静默拒绝会被当成「工具坏了」去排查（坑②的落点）
	if (!process.stdin.isTTY) {
		console.log(`⚠ 无头模式无法确认，默认拒绝：${toolName}`)
		return false
	}
	// 注意文件头 import 的是 node:readline/promises——question 是 await 风格，没有回调参数。
	// 两种 API 混着用（promises 版 + 回调）回调永远不会被调：又一种「看似有返回、实际不结算」
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
	try {
		// EOF（Ctrl+Z/Ctrl+D 关掉输入流）时 question 的 promise 可能永远不结算——
		// 和 close 事件赛跑：close 先到 → 按空答复处理 → 不以 y 开头 → 拒
		const answer = await Promise.race([rl.question(`\n\n权限请求：${toolName}(${JSON.stringify(args)})\n允许执行？(y/n) `), new Promise<string>((resolve) => rl.once('close', () => resolve('')))])
		return answer.trim().toLowerCase().startsWith('y')
	} catch {
		return false // 没问成/没答成，一律按拒（fail-closed）
	} finally {
		rl.close()
	}
}

export const getPermissionConfig = (() => {
	let cache: Promise<PermissionConfig> | undefined
	return async (forceReload = false) => {
		if (forceReload || !cache) {
			cache = loadPermissions().catch((err) => {
				cache = undefined // 失败的 Promise 不留缓存——下次调用重读，文件可能已修好
				throw err // 该失败的照常失败，checkPermission 的兜底接着
			})
		}
		return cache
	}
})()

// ---------- 权限模式层（§7 拆实物拆出来的缺口，补上） ----------
// Claude Code 的 permissions 是两层：defaultMode（模式，管「要不要问你」）叠 allowlist（管「哪些免问」），
// 我们原本只有 allowlist 层。模式只替换「问」这一个动作，不拆任何闸：
//   deny 清单照跑（优先级在模式之前）、pre-hook 照跑、沙箱照跑（长在 impl 层，与权限模式无关）
// auto 的边界（想清楚再放宽）：confirm 档 → 放行，但 run_shell 除外——教学沙箱有已记录的
// 绕过（$() 替换等，sandbox.ts 头注），没有补位层的段不放宽；要「脚本形状自动放行」走参数级
// allow 规则（run_shell(node *)），形状可枚举才可白名单。对照 Claude 的 acceptEdits：
// 自动批编辑、不批 Bash——同一个判断
// 生效优先级：permissions.json 的 mode（用户配置，和规则住一个文件——模式的正主位置）
//   > 环境变量 PERMISSION_MODE（机器默认，适合无头/跑批）> 'default'。
// 「界面上改」在我们这的对应物 = 改 json 重启（与规则同款约定：低频变更 + 高确定性）
const ENV_MODE = (process.env.PERMISSION_MODE ?? 'default').toLowerCase()
if (!['default', 'auto'].includes(ENV_MODE)) {
	console.warn(`⚠ PERMISSION_MODE=${process.env.PERMISSION_MODE} 不认识（只认 default/auto），按 default 走`)
}

// 权限判定总入口——dispatch 的唯一调用点，管线见文件头
export async function checkPermission(toolName: string, args: any): Promise<Verdict> {
	let config
	try {
		config = await getPermissionConfig()
	} catch {
		config = { allow: [], confirm: [], deny: [] }
	}
	// 先deny后allow判断，deny优先
	if (config.deny.some((rule) => matchRule(rule, toolName, args))) {
		return 'deny'
	}
	if (config.allow.some((rule) => matchRule(rule, toolName, args))) {
		return 'allow'
	}
	// confirm 命中或未列出：默认问人；auto 下自动放行（run_shell 除外，理由见模式层注释）。
	// 生效模式 = json 的 mode（用户配置）?? 环境变量——每判一次现取，配置自愈重读后无需重启也跟得上
	if ((config.mode ?? ENV_MODE) === 'auto' && toolName !== 'run_shell') {
		return 'allow'
	}
	return (await askHuman(toolName, args)) ? 'allow' : 'deny'
}
