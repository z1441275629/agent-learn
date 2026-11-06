// 工作台技能注册表：skills/ 目录下 SKILL.md 格式的技能文档（frontmatter name+description + 正文步骤）。
// 机制与 Claude Code 的 skill 同构：系统提示只注入「索引」（name+触发条件，供发现），agent 判断用户
// 需求匹配某技能时调 use_skill 加载全文再照做——索引绝不概括流程（描述概括了 agent 会走捷径跳过正文，
// 这是 skill 发现性设计里被实测验证过的一条）。
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
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`技能文档 ${file} 的 name 不合法（只允许小写字母/数字/连字符）：${name || '(空)'}`)
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
  const readDocs = async (): Promise<SkillDoc[]> => {
    let files: string[]
    try {
      files = await readdir(skillsDir)
    } catch {
      return [] // 目录不存在 = 没有技能，不是错误（个人工具不能因缺目录起不来）
    }
    const docs: SkillDoc[] = []
    for (const f of files.filter((f) => f.endsWith('.md'))) {
      docs.push(parseSkillDoc(await readFile(path.join(skillsDir, f), 'utf8'), f))
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
      // 名字只允许进到文件名（防路径穿越）：不合法直接 null，不读盘
      if (!/^[a-z0-9-]+$/.test(name)) return null
      let text: string
      try {
        text = await readFile(path.join(skillsDir, `${name}.md`), 'utf8')
      } catch {
        return null
      }
      return parseSkillDoc(text, `${name}.md`)
    },
  }
}
