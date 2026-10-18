/*
模块 09 §5：会话持久化与 resume（骨架——存取两函数你来填）

08 的 plan-checkpoint 是雏形（status 在 schema 里，序列化即检查点）；§5 补另一半：
对话本身的落盘与恢复。06 的双账本设计在这里闭环——ledger 只增不删、view 可派生，
天生就是「存储」：落盘落 ledger，恢复重放 add()（双写），view 自动重建。

resume 的三个边界（想清楚再动手）：
  ① tool_call_id 配对：assistant 的 tool_calls 和 tool 结果在 ledger 里天然有序成对，
     原样重放就是合法历史——API 收的是「历史事实」，不重执行、不重扣费
  ② 环境已变：历史工具结果是「当时的事实」，保留；但 system 里的环境块（时钟/文件树）
     是旧会话采的——resume 时必须重采刷新（env.ts 的 refreshEnvBlock），
     否则模型拿着上次的时钟继续推理，§4 白做
  ③ 步数预算：resume 后 maxSteps 重新起算（新一轮 8 步）——历史长度的账归
     ensureBudget 的压缩机制管，不归 step 管
*/
import fs from 'node:fs/promises'
import path from 'node:path'

const SESSIONS_DIR = path.resolve(import.meta.dirname, 'sessions')

// 会话 id：时间戳 + 随机后缀（同秒多次会话不撞名）。用 UTC 没问题——id 只要求
// 唯一且按时间可排序，不承担「给人看时间」的语义（那是 getNow 的活，别学它踩 UTC 坑）
export function newSessionId(): string {
	return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '-' + Math.random().toString(36).slice(2, 6)
}

// TODO 你来写（~6 行）：ledger 落盘
// fs.mkdir(SESSIONS_DIR, { recursive: true }) + fs.writeFile(join(SESSIONS_DIR, `${id}.json`), JSON.stringify(ledger))
// 纪律：永不抛——落盘失败大声报 console.error 后正常返回（持久化是增强不是依赖，
// 存档坏了不能把正在跑的会话也带崩）
export async function saveSession(id: string, ledger: any[]): Promise<void> {
	throw new Error('TODO saveSession')
}

// TODO 你来写（~5 行）：读取存档
// readFile + JSON.parse；文件不存在或损坏 → 返回 null（由调用方大声报）。
// 别抛——resume 一个不存在的 id 是用户输错了，不是程序错误；
// 坏 JSON 返回 null 也一样：恢复不了就明说，别给半截历史
export async function loadSession(id: string): Promise<any[] | null> {
	throw new Error('TODO loadSession')
}
