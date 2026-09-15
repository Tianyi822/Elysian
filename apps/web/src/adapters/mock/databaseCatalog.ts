import type { DatabaseEngine } from '@elysian/contracts'

/*
 * 演示会话的目录数据：每个实例一份确定性目录，语句引擎从这里取全部行与列。
 * 值逐条写死、不随机生成；MySQL 库取 orders 域，PgSQL 库取 elysian 运维域，
 * 与实例语义相称。真实数据库的目录由服务端返回，这里只是演示形状。
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
  'db-postgres-db': {
    engine: 'PgSQL',
    tables: [
      { name: 'incidents', columns: ['id', 'severity', 'status'], rows: [['INC-2026-0901', 'sev2', 'mitigating'], ['INC-2026-0902', 'sev3', 'resolved'], ['INC-2026-0903', 'sev4', 'closed']] },
      { name: 'agent_runs', columns: ['id', 'module_id', 'status'], rows: [['run-2026-0901', 'command-coordination', 'running'], ['run-2026-0902', 'emergency-response', 'waiting-approval'], ['run-2026-0903', 'observability-diagnosis', 'succeeded'], ['run-2026-0904', 'security-governance', 'queued']] },
      { name: 'audit_entries', columns: ['id', 'actor', 'action'], rows: [['aud-2026-0901', '当前用户', 'approval/decided'], ['aud-2026-0902', '应急 Agent', 'tools/execute'], ['aud-2026-0903', '当前用户', 'skills/change']] },
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
}
