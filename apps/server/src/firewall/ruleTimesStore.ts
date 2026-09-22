import { Database } from 'bun:sqlite'
import { ELYSIAN_PATHS } from '../shared/elysianPaths.ts'

/*
 * 防火墙规则时间账本：落在部署机器 ~/.Elysian/data 下（与 metrics.sqlite 同目录）。
 *
 * 账本语义：时间按规范指纹（canonical id）记录，而指纹只含「规则是什么」
 * （动作/方向/协议/端口/来源），不含「何时创建」。面板外删除后重建同规格的
 * 规则，指纹不变，读到的仍是旧时间；ufw 本身也不提供规则创建时刻的查询。
 * 可靠区分外部重建需要轮询内核规则变更或对账快照 diff，属于新机制，本层不引入，
 * 因此这份账本对「同指纹规则的重建」不提供时间可靠性保证。
 */
export const FIREWALL_SQLITE_PATH = ELYSIAN_PATHS.firewallSqlite

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rule_touches (
  canonical_id TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL
);
`

export type FirewallRuleTimes = {
  get(canonicalId: string): string | undefined
  set(canonicalId: string, updatedAt: string): void
  remove(canonicalId: string): void
  close(): void
}

/** 打开（或创建）规则时间账本；Docker 下持久化在命名卷，非 Docker 不会走到这里。 */
export function openRuleTimesStore(path: string): FirewallRuleTimes {
  const db = new Database(path)
  db.exec(SCHEMA)

  const select = db.prepare('SELECT updated_at FROM rule_touches WHERE canonical_id = ?')
  const upsert = db.prepare(
    'INSERT INTO rule_touches (canonical_id, updated_at) VALUES (?, ?) ON CONFLICT(canonical_id) DO UPDATE SET updated_at = excluded.updated_at',
  )
  const drop = db.prepare('DELETE FROM rule_touches WHERE canonical_id = ?')

  return {
    get(canonicalId) {
      const row = select.all(canonicalId)[0] as { updated_at?: unknown } | undefined
      return typeof row?.updated_at === 'string' ? row.updated_at : undefined
    },
    set(canonicalId, updatedAt) {
      upsert.run(canonicalId, updatedAt)
    },
    remove(canonicalId) {
      drop.run(canonicalId)
    },
    close() {
      db.close()
    },
  }
}
