// 工作台技能注册表：skills/ 目录下 SKILL.md 格式的技能文档（frontmatter name+description + 正文步骤）。
// 机制与 Claude Code 的 skill 同构：系统提示只注入「索引」（name+触发条件，供发现），agent 判断用户
// 需求匹配某技能时调 use_skill 加载全文再照做——索引绝不概括流程（描述概括了 agent 会走捷径跳过正文，
// 这是 skill 发现性设计里被实测验证过的一条）。
// 技能两种形态，技能名统一 = 文件/目录名（小写字母/数字/连字符，同时防路径穿越）：
//   1) 单文件  skills/<name>.md
//   2) 文件夹  skills/<name>/SKILL.md（同目录可放支撑文件——模板/参考文档，正文里用 read_file 按需读）
// core/ 只管技能文档的读写与解析，不碰 HTTP、不依赖 LLM。

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

export interface SkillDoc {
  name: string
  description: string
  body: string
}

/** 索引只带触发条件（发现用）；正文只在 load 时进上下文 */
export interface SkillSummary {
  name: string
  description: string
}

/** 技能名只允许小写字母/数字/连字符（name 会拼进路径，同时挡穿越） */
export const SKILL_NAME_RE = /^[a-z0-9-]+$/

/** 解析 SKILL.md：剥 --- frontmatter → name/description，余下是 body。缺必填/格式错 = 抛错（不许静默吞） */
export function parseSkillDoc(markdown: string, file = '<技能>'): SkillDoc {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(markdown)
  if (!m) throw new Error(`技能文档 ${file} 缺 --- frontmatter 围栏`)
  const fm = m[1]
  const body = m[2].trim()
  const field = (key: string) => {
    const line = fm.split('\n').find((l) => l.startsWith(`${key}:`))
    return line ? line.slice(key.length + 1).trim() : ''
  }
  const name = field('name')
  const description = field('description')
  if (!SKILL_NAME_RE.test(name)) throw new Error(`技能文档 ${file} 的 name 不合法（只允许小写字母/数字/连字符）：${name || '(空)'}`)
  if (!description) throw new Error(`技能文档 ${file} 缺 description（触发条件，供发现——不概括流程）`)
  if (!body) throw new Error(`技能文档 ${file} 正文为空`)
  return { name, description, body }
}

/** 系统提示里的技能索引块：只给触发条件 + 一句加载指引，不概括流程（SDO） */
export function renderSkillIndex(skills: SkillSummary[], maxDescriptionChars = 150): string {
  if (!skills.length) return ''
  return (
    '可用技能（用户需求匹配某技能触发条件时，先调 use_skill 加载全文，再严格照技能步骤执行）：\n' +
    skills
      .map((s) => `- ${s.name}：${s.description.length > maxDescriptionChars ? s.description.slice(0, maxDescriptionChars) + '…' : s.description}`)
      .join('\n')
  )
}

export interface SkillStore {
  readonly dir: string
  /** 发现用：全量 name+description（进系统提示） */
  index(): Promise<SkillSummary[]>
  /** 执行用：某技能全文（use_skill 返回给模型）；未知/非法名 → null */
  load(name: string): Promise<SkillDoc | null>
}

export function createSkillStore(skillsDir: string): SkillStore {
  /** 全量扫描：单文件 skills/<name>.md 和文件夹 skills/<name>/SKILL.md 都收。重名/名字不一致 = 抛错（不许静默吞） */
  const readDocs = async (): Promise<SkillDoc[]> => {
    let entries: string[]
    try {
      entries = await readdir(skillsDir)
    } catch {
      return [] // 目录不存在 = 没有技能，不是错误（个人工具不能因缺目录起不来）
    }
    const seen = new Map<string, string>() // 技能名 → 首个出现的文件/目录（重名时报双方）
    const docs: SkillDoc[] = []
    for (const entry of entries) {
      let doc: SkillDoc
      let label: string
      let expectName: string
      if (entry.endsWith('.md')) {
        const stem = entry.slice(0, -3)
        if (!SKILL_NAME_RE.test(stem)) continue // 非技能命名的 md（README 等）不参与索引
        doc = parseSkillDoc(await readFile(path.join(skillsDir, entry), 'utf8'), entry)
        label = entry
        expectName = stem
      } else if (SKILL_NAME_RE.test(entry)) {
        // 文件夹技能：skills/<name>/SKILL.md；目录里没有 SKILL.md = 不是技能（支撑文件/资源目录）
        try {
          doc = parseSkillDoc(await readFile(path.join(skillsDir, entry, 'SKILL.md'), 'utf8'), `${entry}/SKILL.md`)
        } catch (err: any) {
          if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') continue
          throw err // 文件在但读不了/解析错 = 真问题，不许静默吞
        }
        label = `${entry}/SKILL.md`
        expectName = entry
      } else {
        continue // 非技能命名的文件/目录
      }
      if (doc.name !== expectName) {
        throw new Error(`技能 ${label} 的 frontmatter name「${doc.name}」与文件/目录名不一致（技能名必须 = 文件/目录名）`)
      }
      if (seen.has(doc.name)) {
        throw new Error(`技能重名「${doc.name}」：${seen.get(doc.name)} 与 ${label} 撞名（同一技能只能有一个文件/文件夹）`)
      }
      seen.set(doc.name, label)
      docs.push(doc)
    }
    return docs
  }

  return {
    dir: skillsDir,
    async index() {
      const docs = await readDocs()
      return docs
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(({ name, description }) => ({ name, description }))
    },
    async load(name) {
      // 名字只允许进到路径（防穿越）：不合法直接 null，不读盘
      if (!SKILL_NAME_RE.test(name)) return null
      // 单文件形态优先、文件夹形态次之；只读目标技能，别家坏了不连坐
      for (const rel of [`${name}.md`, `${name}/SKILL.md`]) {
        try {
          return parseSkillDoc(await readFile(path.join(skillsDir, rel), 'utf8'), rel)
        } catch {
          continue
        }
      }
      return null
    },
  }
}
