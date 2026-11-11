// 清理 chroma_data 里的废弃段目录。
//
// 背景：Chroma 删除集合只清账本（chroma.sqlite3 的 collections/segments 行），HNSW 段的
// bin 目录留在磁盘上（实测：删除后 segments 表查无此人、目录还在），也没有自动回收开关。
// 判废规则只有一条：账本（segments 表）里没登记的 UUID 目录 = 废弃。
//
// 用法（仓库根目录跑）：
//   node chroma/cleanup-index.ts                 # 干跑：只列清单不动手（默认）
//   node chroma/cleanup-index.ts --clean         # 真删
//   node chroma/cleanup-index.ts 路径 --clean    # 数据目录缺省 chroma/chroma_data
// 服务开着可以干跑看清单；真删可能 EPERM——Windows 下运行中的 chroma 可能还握着
// 已删段的句柄（实测踩过）。删不掉就停 chroma 再跑 --clean，删完重启服务。
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const root = path.resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'chroma/chroma_data')
const clean = process.argv.includes('--clean')
const dbFile = path.join(root, 'chroma.sqlite3')
if (!fs.existsSync(dbFile)) {
  console.error(`找不到 ${dbFile}——路径对吗？（用法：node chroma/cleanup-index.ts [数据目录] [--clean]）`)
  process.exit(1)
}

// 账本：登记的段 id = 现役；顺带取集合名让清单可读
const db = new DatabaseSync(dbFile, { readOnly: true })
const segments = db.prepare('SELECT id, collection FROM segments').all() as {
  id: string
  collection: string
}[]
const collections = new Map<string, string>()
for (const c of db.prepare('SELECT id, name FROM collections').all() as { id: string; name: string }[])
  collections.set(c.id, c.name)
db.close()

const live = new Map(segments.map((s) => [s.id, s.collection]))
const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const dirs = fs
  .readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory() && isUuid.test(d.name))
  .map((d) => d.name)

console.log(`数据目录 ${root}：账本登记段 ${live.size} 个 · 磁盘 UUID 目录 ${dirs.length} 个\n`)

const dirSize = (dir: string): number =>
  fs.readdirSync(dir).reduce((s, f) => {
    const st = fs.statSync(path.join(dir, f))
    return s + (st.isFile() ? st.size : 0)
  }, 0)

const orphans: string[] = []
for (const name of dirs) {
  const colId = live.get(name)
  if (colId != null) {
    console.log(`  现役  ${name.slice(0, 8)}… → 集合「${collections.get(colId) ?? colId.slice(0, 8)}」`)
  } else {
    orphans.push(name)
  }
}
if (orphans.length === 0) {
  console.log('\n没有废弃目录，不用清。')
  process.exit(0)
}
let freed = 0
for (const name of orphans) {
  const size = dirSize(path.join(root, name))
  freed += size
  console.log(`  废弃  ${name.slice(0, 8)}…  ${(size / 1024).toFixed(0)}KB`)
}

if (!clean) {
  console.log(`\n共 ${orphans.length} 个废弃目录、约 ${(freed / 1024).toFixed(0)}KB——确认无误后加 --clean 真删`)
  process.exit(0)
}
// maxRetries 只救「瞬时占用」；服务端长握句柄的救不了，逐个兜错并指路
let failed = 0
for (const name of orphans) {
  try {
    fs.rmSync(path.join(root, name), { recursive: true, maxRetries: 3, retryDelay: 200 })
    console.log(`  已删  ${name.slice(0, 8)}…`)
  } catch (err: any) {
    failed++
    console.log(`  ✗ 删不动  ${name.slice(0, 8)}…（${err?.code ?? err?.message}）——被运行中的 chroma 占着，停服务再跑一次`)
  }
}
console.log(
  failed
    ? `\n清理完成：成功 ${orphans.length - failed} 个，失败 ${failed} 个（停 chroma → 重跑 --clean → 重启服务）`
    : `\n已清理 ${orphans.length} 个废弃目录，释放约 ${(freed / 1024).toFixed(0)}KB`,
)
process.exit(failed ? 1 : 0)
