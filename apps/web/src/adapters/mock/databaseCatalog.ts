import type { DatabaseEngine } from '@elysian/contracts'

/*
 * 演示会话的目录数据：每个实例一份确定性目录，语句引擎从这里取全部行与列。
 * 值逐条写死、不随机生成；MySQL 库取 orders 域，与实例语义相称。
 * 真实数据库的目录由服务端返回，这里只是演示形状。
 */

export type CatalogTable = {
  name: string
  columns: readonly string[]
  rows: readonly (readonly string[])[]
}

export type CatalogKey = { name: string; type: string; value: string }

export type DatabaseCatalog = {
  engine: DatabaseEngine
  tables: readonly CatalogTable[]
  keys: readonly CatalogKey[]
}

export const DATABASE_CATALOG: Record<string, DatabaseCatalog> = {
  'db-mariadb-primary': {
    engine: 'MariaDB',
    tables: [
      { name: 'users', columns: ['id', 'name', 'created_at'], rows: [['1', 'alice', '2026-08-01 09:12:04'], ['2', 'bob', '2026-08-03 14:20:51'], ['3', 'carol', '2026-08-19 07:45:10']] },
      { name: 'orders', columns: ['id', 'user_id', 'amount'], rows: [['1001', '1', '268.00'], ['1002', '2', '1138.50'], ['1003', '1', '42.00']] },
      { name: 'sessions', columns: ['id', 'user_id', 'expires_at'], rows: [['s-1', '1', '2026-09-20 00:00:00'], ['s-2', '3', '2026-09-18 12:00:00']] },
    ],
    keys: [],
  },
  'db-mysql-orders': {
    engine: 'MySQL',
    tables: [
      { name: 'customers', columns: ['id', 'name', 'tier'], rows: [['1', 'acme-mall', 'enterprise'], ['2', 'globex-app', 'business'], ['3', 'initech-io', 'standard']] },
      { name: 'orders', columns: ['order_no', 'customer_id', 'amount'], rows: [['A-2026-0901', '1', '599.00'], ['A-2026-0902', '2', '128.40'], ['A-2026-0903', '1', '3299.00'], ['A-2026-0904', '3', '88.00']] },
      { name: 'payments', columns: ['order_no', 'method', 'paid_at'], rows: [['A-2026-0901', 'alipay', '2026-09-01 10:05:33'], ['A-2026-0903', 'card', '2026-09-02 18:44:02'], ['A-2026-0904', 'wechat', '2026-09-03 08:12:47']] },
    ],
    keys: [],
  },
  'db-redis-cache': {
    engine: 'Redis',
    tables: [],
    keys: [
      { name: 'session:1001', type: 'hash', value: '{user: alice, ttl: 1800}' },
      { name: 'queue:emails', type: 'list', value: '3 items' },
      { name: 'rate:api', type: 'string', value: '148' },
    ],
  },
  'db-sqlite-notes': {
    engine: 'SQLite',
    tables: [
      { name: 'notes', columns: ['id', 'title', 'body'], rows: [['1', '巡检记录', '磁盘余量偏低，已清理旧日志'], ['2', '变更备忘', '把连接池上限从 100 提到 200'], ['3', '待办', '给审计表加索引']] },
      { name: 'tags', columns: ['id', 'note_id', 'name'], rows: [['1', '1', '巡检'], ['2', '2', '变更'], ['3', '3', '待办']] },
      { name: 'attachments', columns: ['id', 'note_id', 'path'], rows: [['1', '1', '/srv/elysian/data/attachments/disk.png']] },
    ],
    keys: [],
  },
}

/**
 * 新建或上传的 SQLite 库登记一份空目录：新建的空库本来就没有表，
 * 上传的既有文件在演示里读不到内容，因此不编造它的表结构（SHOW TABLES 给 Empty set）。
 */
export function registerSqliteCatalog(databaseId: string): void {
  DATABASE_CATALOG[databaseId] = { engine: 'SQLite', tables: [], keys: [] }
}
