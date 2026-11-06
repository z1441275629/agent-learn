// 仓库能力（模块 15 能力工具）：git_log / read_file / write_file 的执行器 + 安全守门。
// 与 browser.ts 同构——tools.ts 只接线，这里做真实 IO（child_process git / fs）与路径安全。
// 安全模型：路径一律仓库相对、拒绝穿越/绝对；读挡 .env 与工作台自己的 dataDir；写只放行白名单目录。

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'

const execFileAsync = promisify(execFile)

/** 单次返回的文本上限（git log / 文件内容）——源头截断，别让超长结果撑爆上下文 */
const MAX_REPO_TEXT = 6000

export interface RepoConfig {
  /** 仓库根（相对路径都基于它解析） */
  repoDir: string
  /** 可写目录白名单（相对 repoDir 的第一段，如 'reviews'、'personal-agent/skills'） */
  writableDirs: string[]
  /** 读取黑名单（绝对路径；写侧白名单已天然挡住，读侧要显式挡工作台自己的数据） */
  denyReads: string[]
}

export interface RepoReader {
  /** 最近提交；since/until 为时间窗（today 00:00 / 3 days / 2026-11-05，都省略 = 最近 20 条）；
   *  圈定单日必须 since=该日 + until=该日的次日（since 是下界，不配 until 会混入其后几天的提交） */
  gitLog(since?: string, until?: string, max?: number): Promise<string>
  /** 读仓库内文件（仓库相对路径），超长截断 */
  readFile(rel: string): Promise<string>
  /** 写仓库内文件（白名单目录 + 确认门在 tools 层），返回结果字符串 */
  writeFile(rel: string, content: string): Promise<string>
}

export function repoError(message: string, code = 400): Error {
  return Object.assign(new Error(message), { code })
}

/** 把仓库相对路径解析成绝对路径；拒绝空/绝对/穿越/越界 */
function resolveInside(repoDir: string, rel: string): string {
  if (!rel || typeof rel !== 'string') throw repoError('路径不能为空')
  if (path.isAbsolute(rel)) throw repoError('请用仓库相对路径，如 reviews/2026-11-06.md')
  const normalized = path.normalize(rel).replace(/^[\\/]+/, '')
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`) || normalized.startsWith('../'))
    throw repoError('路径不能越出仓库')
  const root = path.resolve(repoDir)
  const resolved = path.resolve(root, normalized)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw repoError('路径越出仓库边界')
  return resolved
}

function checkDeny(resolved: string, denyReads: string[]): void {
  if (path.basename(resolved).startsWith('.env')) throw repoError('读不了 .env（密钥文件）', 403)
  for (const d of denyReads) {
    if (resolved === d || resolved.startsWith(d + path.sep)) throw repoError('读不了工作台自己的数据目录', 403)
  }
}

function checkWritable(resolved: string, repoDir: string, writableDirs: string[]): void {
  const rel = path.relative(path.resolve(repoDir), resolved)
  const firstSeg = rel.split(path.sep)[0]
  if (!writableDirs.includes(firstSeg)) throw repoError(`只能写白名单目录：${writableDirs.join('、')}`, 403)
}

export function createRepoReader(config: RepoConfig): RepoReader {
  const root = path.resolve(config.repoDir)
  return {
    async gitLog(since, until, max = 20) {
      const count = Math.max(1, Math.min(Math.floor(Number(max)) || 20, 100))
      const args = ['log', '--date=short', `--pretty=format:%h %ad %s`, `--max-count=${count}`]
      const sinceStr = since ? String(since).trim() : ''
      if (sinceStr) args.push(`--since=${sinceStr}`)
      const untilStr = until ? String(until).trim() : ''
      if (untilStr) args.push(`--until=${untilStr}`)
      try {
        const { stdout } = await execFileAsync('git', args, { cwd: root, maxBuffer: 1024 * 1024 })
        const out = stdout.trim()
        return out ? `最近提交：\n${out}` : '（这个时间段内没有提交）'
      } catch (err: any) {
        if (String(err?.code) === 'ENOENT') throw repoError('git 不可用（未安装或不在 PATH）')
        throw repoError(`git log 失败：${err?.message ?? String(err).slice(0, 120)}`)
      }
    },
    async readFile(rel) {
      const resolved = resolveInside(root, rel)
      checkDeny(resolved, config.denyReads)
      try {
        const content = await fs.readFile(resolved, 'utf8')
        return content.length > MAX_REPO_TEXT
          ? content.slice(0, MAX_REPO_TEXT) + `\n…（截断，共 ${content.length} 字符）`
          : content
      } catch (err: any) {
        if (err?.code === 'ENOENT') throw repoError(`文件不存在：${rel}`)
        throw repoError(`读取失败：${err?.message ?? String(err)}`)
      }
    },
    async writeFile(rel, content) {
      const resolved = resolveInside(root, rel)
      checkWritable(resolved, root, config.writableDirs)
      if (typeof content !== 'string' || !content.trim()) throw repoError('content 不能为空')
      await fs.mkdir(path.dirname(resolved), { recursive: true })
      await fs.writeFile(resolved, content, 'utf8')
      return `已写入 ${rel}（${content.length} 字符）`
    },
  }
}
