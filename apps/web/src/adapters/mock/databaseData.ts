import type { DatabaseInstance } from '@elysian/contracts'

/** 演示用的 SQLite 版本（引擎版本随库文件格式走，与宿主版本无关）。 */
export const SQLITE_VERSION = '3.46.1'

/**
 * 数据库资源卡片的确定性演示数据。数据库由容器承载，因此这里只记来源容器的 id；
 * 地址字段不存在——数据库监听在容器里，界面给不出域名或 IP。
 * 凭证是演示值，逐条写死、不随机生成。
 */
const instances: DatabaseInstance[] = [
  {
    id: 'db-mariadb-primary',
    engine: 'MariaDB',
    name: 'mariadb-primary',
    version: '10.11.8',
    status: 'running',
    containerId: 'ctr-mariadb-primary',
    credentials: { username: 'ops', password: 'demo-mariadb-7f2c' },
    storage: { usedGb: 128.4, totalGb: 256 },
    memory: { usedGb: 3.2, totalGb: 8 },
    connections: { active: 86, max: 200 },
    updatedAt: '2026-09-12T08:00:00.000Z',
  },
  {
    id: 'db-mysql-orders',
    engine: 'MySQL',
    name: 'mysql-orders',
    version: '8.4.2',
    status: 'warning',
    containerId: 'ctr-mysql-orders',
    credentials: { username: 'ops', password: 'demo-mysql-3b91' },
    storage: { usedGb: 74.8, totalGb: 128 },
    memory: { usedGb: 4.6, totalGb: 8 },
    connections: { active: 142, max: 200 },
    updatedAt: '2026-09-12T08:00:00.000Z',
  },
  {
    id: 'db-redis-cache',
    engine: 'Redis',
    name: 'redis-cache',
    version: '7.4',
    status: 'running',
    containerId: 'ctr-redis-cache',
    credentials: { username: 'default', password: 'demo-redis-9a40' },
    storage: { usedGb: 2.4, totalGb: 16 },
    memory: { usedGb: 0.6, totalGb: 2 },
    connections: { active: 34, max: 512 },
    updatedAt: '2026-09-12T08:00:00.000Z',
  },
  {
    // 文件型：SQLite 就是一个本地 .db 文件，没有容器、没有账号、没有连接上限。
    id: 'db-sqlite-notes',
    engine: 'SQLite',
    name: 'elysian-notes',
    version: SQLITE_VERSION,
    status: 'running',
    filePath: '/srv/elysian/data/sqlite/elysian-notes.db',
    fileSizeMb: 4.2,
    tableCount: 3,
    lastWrittenAt: '2026-09-11T15:20:00.000Z',
    updatedAt: '2026-09-12T08:00:00.000Z',
  },
]

/** 只读出口：读方拿到的形状不变，create 经 addDatabaseInstance 追加。 */
export const DATABASE_INSTANCES: readonly DatabaseInstance[] = instances

/** 创建数据库（演示）的落点：追加进内存数据集，刷新即重置。 */
export function addDatabaseInstance(instance: DatabaseInstance): void {
  instances.push(instance)
}

/** 删除数据库（演示）的落点：只移除内存数据集里的这一条。 */
export function removeDatabaseInstance(databaseId: string): void {
  const index = instances.findIndex((instance) => instance.id === databaseId)
  if (index !== -1) instances.splice(index, 1)
}
