// HTTP 小件：JSON 应答 / 请求体读取（25MB 上限）/ dataURL 解码。
// 从原零依赖版原样搬来——koa-bodyparser 也能做，但 413 带错误码的语义是我们 E2E 的断言面，手写 15 行保行为
import type { Context } from 'koa'

const MAX_BODY = 25 * 1024 * 1024 // 截图/图片附件一般在几 MB；25MB 上限防误打爆

export const json = (ctx: Context, code: number, data: unknown) => {
  ctx.status = code
  ctx.type = 'application/json; charset=utf-8'
  ctx.body = JSON.stringify(data)
}

/** 读请求体为字符串；超限抛带 code:413 的错误（错误映射中间件转状态码） */
export async function readBody(ctx: Context): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of ctx.req) {
    size += chunk.length
    if (size > MAX_BODY) throw Object.assign(new Error('请求体太大（上限 25MB）'), { code: 413 })
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** 解析 + 校验 JSON 请求体：非对象/解析失败给 400（原来直接 500，行为收紧为更诚实的 400） */
export async function readJsonBody<T extends object>(ctx: Context): Promise<T> {
  const raw = await readBody(ctx)
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') throw new Error('not object')
    return parsed as T
  } catch {
    throw Object.assign(new Error('请求体不是合法 JSON'), { code: 400 })
  }
}

// "data:image/png;base64,xxx" 或裸 base64 都收
export function decodeImage(input: string): Buffer {
  const m = /^data:image\/[a-z0-9.+-]+;base64,(.*)$/is.exec(input)
  const b64 = m ? m[1] : input
  const buf = Buffer.from(b64, 'base64')
  if (buf.length === 0) throw Object.assign(new Error('图片解码为空'), { code: 400 })
  return buf
}
