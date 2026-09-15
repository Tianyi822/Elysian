import type { DatabaseInstance } from '@elysian/contracts'

/**
 * 数据库资源卡片的确定性演示数据。地址只用于界面展示，不对应真实基础设施。
 * 数值保留一位小数，便于卡片在不同屏幕宽度下保持稳定高度。
 */
export const DATABASE_INSTANCES: readonly DatabaseInstance[] = [
  {
    id: 'db-mariadb-primary',
    engine: 'MariaDB',
    name: 'mariadb-primary',
    host: 'mariadb-primary.demo',
    port: 3306,
    version: '10.11.8',
    status: 'running',
    statusLabel: '运行中',
    storage: { usedGb: 128.4, totalGb: 256 },
    memory: { usedGb: 3.2, totalGb: 8 },
    connections: { active: 86, max: 200 },
    uptime: '12 天 6 小时',
    updatedAt: '2026-09-12T08:00:00.000Z',
  },
  {
    id: 'db-mysql-orders',
    engine: 'MySQL',
    name: 'mysql-orders',
    host: 'mysql-orders.demo',
    port: 3306,
    version: '8.4.2',
    status: 'warning',
    statusLabel: '连接偏高',
    storage: { usedGb: 74.8, totalGb: 128 },
    memory: { usedGb: 4.6, totalGb: 8 },
    connections: { active: 142, max: 200 },
    uptime: '8 天 19 小时',
    updatedAt: '2026-09-12T08:00:00.000Z',
  },
]

