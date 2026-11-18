// 会话索引层：列表元数据进 SQLite（分页/排序 O(1)），消息账本仍是 JSON 文件。
// 索引是缓存不是事实源——可随时删掉 .db 重建，reconcile 按 (mtimeMs, size) 指纹对账自动补齐；
// 事实源永远是 JSON 文件，索引坏了不丢任何数据。
// better-sqlite3 本征同步 API：单用户无争用，同步换简单。
import Database from 'better-sqlite3'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { SessionDoc } from './sessions.ts'

export interface IndexRow {
  id: string
  title: string
  updatedAt: string
  messageCount: number
  mtimeMs: number
  size: number
}

export interface SessionIndex {
  list(limit: number, offset: number): { rows: IndexRow[]; total: number }
  upsert(row: IndexRow): void
  remove(id: string): void
  /** 指纹对账：一致的跳过、不一致/缺失的重读重灌、文件已删的孤儿行清掉 */
  reconcile(sessionsDir: string, loadDoc: (id: string) => Promise<SessionDoc | null>): Promise<void>
  close(): void
}

export function createSessionIndex(dbPath: string): SessionIndex {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(`CREATE TABLE IF NOT EXISTS sessions_index (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    message_count INTEGER NOT NULL,
    mtime_ms INTEGER NOT NULL,
    size INTEGER NOT NULL
  )`)

  const stmtList = db.prepare(
    'SELECT id, title, updated_at AS updatedAt, message_count AS messageCount, mtime_ms AS mtimeMs, size FROM sessions_index ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?',
  )
  const stmtCount = db.prepare('SELECT COUNT(*) AS n FROM sessions_index')
  const stmtUpsert = db.prepare(
    `INSERT INTO sessions_index (id, title, updated_at, message_count, mtime_ms, size)
     VALUES (@id, @title, @updatedAt, @messageCount, @mtimeMs, @size)
     ON CONFLICT(id) DO UPDATE SET title=@title, updated_at=@updatedAt, message_count=@messageCount, mtime_ms=@mtimeMs, size=@size`,
  )
  const stmtRemove = db.prepare('DELETE FROM sessions_index WHERE id = ?')
  const stmtAllIds = db.prepare('SELECT id FROM sessions_index')
  const stmtFingerprint = db.prepare('SELECT mtime_ms, size FROM sessions_index WHERE id = ?')

  return {
    list(limit, offset) {
      const rows = stmtList.all(limit, offset) as IndexRow[]
      const total = (stmtCount.get() as { n: number }).n
      return { rows, total }
    },

    upsert(row) {
      stmtUpsert.run(row)
    },

    remove(id) {
      stmtRemove.run(id)
    },

    async reconcile(sessionsDir, loadDoc) {
      let names: string[]
      try {
        names = await fsp.readdir(sessionsDir)
      } catch {
        // 目录没了 = 没有会话：清空索引即可
        db.exec('DELETE FROM sessions_index')
        return
      }
      const seen = new Set<string>()
      for (const name of names) {
        if (!name.endsWith('.json')) continue
        const id = name.slice(0, -'.json'.length)
        const full = path.join(sessionsDir, name)
        let st: Awaited<ReturnType<typeof fsp.stat>>
        try {
          st = await fsp.stat(full)
        } catch {
          continue
        }
        seen.add(id)
        const fp = stmtFingerprint.get(id) as { mtime_ms: number; size: number } | undefined
        const mtimeMs = Math.round(st.mtimeMs)
        if (fp && fp.mtime_ms === mtimeMs && fp.size === st.size) continue // 指纹一致，跳过
        const doc = await loadDoc(id)
        if (!doc) continue // 文件读不出（半截/损坏）：不灌索引，问题留给真正的 load 暴露
        stmtUpsert.run({
          id: doc.id,
          title: doc.title,
          updatedAt: doc.updatedAt,
          messageCount: doc.messages.length,
          mtimeMs,
          size: st.size,
        })
      }
      // 孤儿行：索引里有、文件已不在
      for (const { id } of stmtAllIds.all() as { id: string }[]) {
        if (!seen.has(id)) stmtRemove.run(id)
      }
    },

    close() {
      db.close()
    },
  }
}
