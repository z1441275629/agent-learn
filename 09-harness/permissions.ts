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
    默认 deny 太严会训练人无脑点允许，默认 allow 形同虚设，confirm 是安全默认）

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
	allow: string[]
	confirm: string[]
	deny: string[]
}

const CONFIG_PATH = path.resolve(import.meta.dirname, 'permissions.json')

// 启动时读一次，改规则重启生效（热重载不值得做——权限配置本来就该低频变更+高确定性）
export async function loadPermissions(): Promise<PermissionConfig> {
	try {
		return JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'))
	} catch {
		// 配置缺失/损坏 = 全部走 confirm（fail-safe：宁可多问一句，不可静默放行）
		return { allow: [], confirm: [], deny: [] }
	}
}

// 规则匹配：一条规则是否命中 (toolName, args)
// 工具级 "tool" 直接比名；参数级 "tool(参数模式)" 先 TODO——§2 沙箱上线时一起实现
function matchRule(rule: string, toolName: string, args: any): boolean {
	// TODO 你来写（~8 行）：
	// 1. 括号拆分：/^([a-z_]+)(?:\((.+)\))?$/ 提取工具名和可选的参数模式
	// 2. 工具名不等 → false
	// 3. 无参数模式 → true（工具级规则，命中）
	// 4. 有参数模式 → TODO §2：按 "参数名=通配模式" 匹配 args（glob 或正则，选一个说清楚为什么）
	throw new Error('TODO matchRule')
}

// human-in-the-loop：TTY 上问一句，返回用户批没批
// 金笔记：这是整个 harness 唯一「人的声音能进来」的地方——问题文案要让人能做判断：
//   打出 工具名 + 完整参数（截断的参数让人批准的是盲盒），别打「允许吗？(y/n)」
async function askHuman(toolName: string, args: any): Promise<boolean> {
	// TODO 你来写（~12 行）：
	// 1. process.stdin.isTTY 为假（无头：planner 子 agent / 管道 / 后台）→ return false + 大声报
	//    「无头模式无法确认，默认拒绝」（坑②的落点）
	// 2. readline.createInterface({ input, output }) → question(`权限请求：${toolName}(${JSON.stringify(args)})\n允许执行？(y/n) `)
	// 3. 答复 trim().toLowerCase() 以 'y' 开头才 true；EOF / 异常一律 false
	throw new Error('TODO askHuman')
}

// 权限判定总入口——dispatch 的唯一调用点，管线见文件头
export async function checkPermission(toolName: string, args: any): Promise<Verdict> {
	// TODO 你来写（~10 行）：
	// 1. const config = await loadPermissions()（或模块级缓存——启动读一次，
	//    别每次工具调用都读盘；想清楚缓存在哪一层：模块级变量 / dispatch 传入）
	// 2. config.deny.some(rule => matchRule(rule, toolName, args)) → 'deny'
	// 3. config.allow.some(...) → 'allow'
	// 4. 其余（confirm 命中或未列出）→ (await askHuman(...)) ? 'allow' : 'deny'
	//    ——注意：checkPermission 返回的三值里没有 'confirm'，confirm 的归宿是被翻译成
	//    allow/deny；dispatch 只认识放行/拦截
	throw new Error('TODO checkPermission')
}
