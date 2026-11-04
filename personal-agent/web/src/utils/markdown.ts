// 轻量 markdown 渲染（够聊天用：标题/列表/代码块/行内代码/粗体/链接）
//
// 安全策略：**先整体 HTML 转义，再插入白名单标签**。模型输出里的 <script> 在第一步就变成
// 纯文本；后面 append 的只有我们自己生成的标签，v-html 因此不会成为 XSS 入口。

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c])

const inline = (s: string) =>
  s
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')

export function markdownToHtml(src: string): string {
  const lines = esc(src).split('\n')
  let out = ''
  let inCode = false
  let inList = false
  for (const line of lines) {
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
      }
      continue
    }
    if (inCode) {
      out += line + '\n'
      continue
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
