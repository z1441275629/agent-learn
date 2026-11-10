// 轻量 markdown 渲染（够聊天用：标题/列表/代码块/行内代码/粗体/链接/GFM 表格）
//
// 安全策略：**先整体 HTML 转义，再插入白名单标签**。模型输出里的 <script> 在第一步就变成
// 纯文本；后面 append 的只有我们自己生成的标签，v-html 因此不会成为 XSS 入口。

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c])

const inline = (s: string) =>
  s
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    // 图片只放行自家 /api/ 路径（会话图/体检截图）——外链/协议相对/data: 一律不当图渲染，
    // 防外链跟踪与奇怪注入；链接仍只认 http(s)
    .replace(/!\[([^\]]*)\]\((\/api\/[a-z0-9/_\-.]+)\)/g, '<img alt="$1" src="$2" loading="lazy">')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')

// ---------- GFM 表格 ----------
// 表头/分隔行/数据行都按 | 切分；单元格里 \| 是字面竖线，切分前用占位符护住、切完还原
const PIPE_PLACEHOLDER = '\u0000'

function splitRow(line: string): string[] {
  let s = line.trim().replace(/\\\|/g, PIPE_PLACEHOLDER)
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map((cell) => cell.trim().replace(/\u0000/g, '|'))
}

/** 分隔行每格 :--- / ---: / :---: / --- → 对齐方式；任何一格不合法返回 null（不是分隔行） */
function rowAligns(cells: string[]): Array<'left' | 'center' | 'right'> | null {
  const aligns: Array<'left' | 'center' | 'right'> = []
  for (const cell of cells) {
    const m = /^(:?)(-+)(:?)$/.exec(cell)
    if (!m) return null
    if (m[1] && m[3]) aligns.push('center')
    else if (m[3]) aligns.push('right')
    else aligns.push('left') // :--- 与 --- 都算左（GFM 默认）
  }
  return aligns
}

// 对齐只在非默认时输出 style，省一点噪音；标签属性是我们拼的，值只有三个枚举——无注入面
const alignAttr = (a: 'left' | 'center' | 'right') => (a === 'left' ? '' : ` style="text-align:${a}"`)

export function markdownToHtml(src: string): string {
  const lines = esc(src).split('\n')
  let out = ''
  let inCode = false
  let inList = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('```')) {
      if (inCode) {
        out += '</code></pre>'
        inCode = false
      } else {
        if (inList) {
          out += '</ul>'
          inList = false
        }
        out += '<pre><code>'
        inCode = true
      }
      continue
    }
    if (inCode) {
      out += line + '\n'
      continue
    }
    // 表格前瞻：当前行含 |、下一行是分隔行且列数对得上 → 表头+分隔行落定，数据行吃到不含 | 或空行为止
    if (line.includes('|') && i + 1 < lines.length) {
      const header = splitRow(line)
      const aligns = rowAligns(splitRow(lines[i + 1]))
      if (aligns && aligns.length > 0 && header.length === aligns.length) {
        if (inList) {
          out += '</ul>'
          inList = false
        }
        out += `<table><thead><tr>${header
          .map((cell, k) => `<th${alignAttr(aligns[k])}>${inline(cell)}</th>`)
          .join('')}</tr></thead><tbody>`
        for (let j = i + 2; j < lines.length; j++) {
          const l = lines[j]
          if (!l.includes('|') || !l.trim()) break
          const cells = splitRow(l)
          // 列数不齐：短的补空、长的截断（GFM 行为）
          out += `<tr>${aligns
            .map((a, k) => `<td${alignAttr(a)}>${inline(cells[k] ?? '')}</td>`)
            .join('')}</tr>`
          i = j
        }
        out += '</tbody></table>'
        continue
      }
    }
    const h = /^(#{1,3}) (.+)$/.exec(line)
    if (h) {
      if (inList) {
        out += '</ul>'
        inList = false
      }
      out += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`
      continue
    }
    if (/^[-*] /.test(line)) {
      if (!inList) {
        out += '<ul>'
        inList = true
      }
      out += `<li>${inline(line.slice(2))}</li>`
      continue
    }
    if (inList) {
      out += '</ul>'
      inList = false
    }
    if (!line.trim()) {
      out += '<div class="gap"></div>'
      continue
    }
    out += `<p>${inline(line)}</p>`
  }
  if (inCode) out += '</code></pre>'
  if (inList) out += '</ul>'
  return out
}
