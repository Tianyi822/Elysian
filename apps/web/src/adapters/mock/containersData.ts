import type { Container, ContainerImage } from '@elysian/contracts'
import { DATASET_BASE_TIME } from './seed.ts'

/** 相对基准时间回推 hours 小时的 ISO 时间。 */
const before = (hours: number): string =>
  new Date(new Date(DATASET_BASE_TIME).getTime() - hours * 3_600_000).toISOString()

export const CONTAINER_IMAGES: readonly ContainerImage[] = [
  { id: 'img-nginx', name: 'nginx', tag: '1.27-alpine', digest: 'sha256:0e3a11c2d4f5', sizeMb: 92, pulledAt: before(720) },
  { id: 'img-redis', name: 'redis', tag: '7.4-alpine', digest: 'sha256:1b7d99e2a1c8', sizeMb: 138, pulledAt: before(700) },
  { id: 'img-postgres', name: 'postgres', tag: '16.4', digest: 'sha256:2c9e55f0b7a3', sizeMb: 431, pulledAt: before(672) },
  { id: 'img-node', name: 'node', tag: '22-alpine', digest: 'sha256:3f0b76cc9d21', sizeMb: 180, pulledAt: before(240) },
  { id: 'img-alpine', name: 'alpine', tag: '3.20', digest: 'sha256:4a1c88f3e0b9', sizeMb: 8, pulledAt: before(480) },
  { id: 'img-grafana', name: 'grafana/grafana', tag: '11.3.0', digest: 'sha256:5d2fa6b8c417', sizeMb: 398, pulledAt: before(216) },
  { id: 'img-mariadb', name: 'mariadb', tag: '10.11', digest: 'sha256:6b4e12aa90f3', sizeMb: 396, pulledAt: before(168) },
  { id: 'img-mysql', name: 'mysql', tag: '8.4', digest: 'sha256:7c5a30dd41b8', sizeMb: 612, pulledAt: before(168) },
]

export const CONTAINERS: readonly Container[] = [
  {
    id: 'ctr-nginx-proxy', name: 'nginx-proxy', status: 'running', imageId: 'img-nginx',
    ports: [
      { containerPort: 80, hostPort: 8080, protocol: 'tcp' },
      { containerPort: 443, hostPort: 8443, protocol: 'tcp' },
    ],
    createdAt: before(720), startedAt: before(96),
    command: "nginx -g 'daemon off;'",
    env: [{ key: 'TZ', value: 'Asia/Shanghai' }],
    volumes: [{ hostPath: '/srv/elysian/conf/nginx', containerPath: '/etc/nginx/conf.d' }],
    restartPolicy: 'always',
  },
  {
    id: 'ctr-redis-cache', name: 'redis-cache', status: 'running', imageId: 'img-redis',
    ports: [{ containerPort: 6379, hostPort: 6379, protocol: 'tcp' }],
    createdAt: before(700), startedAt: before(96),
    command: 'redis-server --appendonly yes',
    env: [], volumes: [{ hostPath: '/srv/elysian/data/redis', containerPath: '/data' }],
    restartPolicy: 'always',
  },
  {
    id: 'ctr-postgres-db', name: 'postgres-db', status: 'running', imageId: 'img-postgres',
    ports: [{ containerPort: 5432, hostPort: 15432, protocol: 'tcp' }],
    createdAt: before(672), startedAt: before(96),
    command: 'postgres -c shared_buffers=256MB',
    env: [
      { key: 'POSTGRES_DB', value: 'elysian' },
      { key: 'POSTGRES_USER', value: 'ops' },
    ],
    volumes: [{ hostPath: '/srv/elysian/data/pg', containerPath: '/var/lib/postgresql/data' }],
    restartPolicy: 'unless-stopped',
  },
  {
    id: 'ctr-elysian-web', name: 'elysian-web', status: 'running', imageId: 'img-node',
    ports: [{ containerPort: 5173, hostPort: 5173, protocol: 'tcp' }],
    createdAt: before(240), startedAt: before(12),
    command: 'bun run dev',
    env: [{ key: 'NODE_ENV', value: 'development' }],
    volumes: [{ hostPath: '/srv/elysian/apps/web', containerPath: '/app' }],
    restartPolicy: 'unless-stopped',
  },
  {
    id: 'ctr-elysian-worker', name: 'elysian-worker', status: 'running', imageId: 'img-node',
    ports: [],
    createdAt: before(240), startedAt: before(12),
    command: 'bun run worker',
    env: [], volumes: [],
    restartPolicy: 'on-failure',
  },
  {
    id: 'ctr-log-shipper', name: 'log-shipper', status: 'running', imageId: 'img-alpine',
    ports: [{ containerPort: 24224, hostPort: 24224, protocol: 'udp' }],
    createdAt: before(480), startedAt: before(48),
    command: 'tail -f /var/log/containers/access.log',
    env: [], volumes: [{ hostPath: '/var/log/containers', containerPath: '/var/log/containers' }],
    restartPolicy: 'always',
  },
  {
    id: 'ctr-backup-agent', name: 'backup-agent', status: 'stopped', imageId: 'img-node',
    ports: [],
    createdAt: before(624), startedAt: undefined,
    command: 'bun run backup',
    env: [], volumes: [{ hostPath: '/srv/elysian/backups', containerPath: '/backups' }],
    restartPolicy: 'no',
  },
  {
    id: 'ctr-metrics-agent', name: 'metrics-agent', status: 'restarting', imageId: 'img-node',
    ports: [{ containerPort: 9090, hostPort: 9090, protocol: 'tcp' }],
    createdAt: before(600), startedAt: before(2),
    command: 'bun run metrics-agent',
    env: [{ key: 'SCRAPE_INTERVAL', value: '15s' }],
    volumes: [{ hostPath: '/srv/elysian/conf/metrics', containerPath: '/etc/metrics' }],
    restartPolicy: 'always',
  },
  {
    id: 'ctr-mariadb-primary', name: 'mariadb-primary', status: 'running', imageId: 'img-mariadb',
    ports: [{ containerPort: 3306, hostPort: 13306, protocol: 'tcp' }],
    createdAt: before(720), startedAt: before(294),
    command: 'mariadbd --character-set-server=utf8mb4',
    env: [{ key: 'MARIADB_DATABASE', value: 'elysian' }],
    volumes: [{ hostPath: '/srv/elysian/data/mariadb', containerPath: '/var/lib/mysql' }],
    restartPolicy: 'always',
  },
  {
    id: 'ctr-mysql-orders', name: 'mysql-orders', status: 'running', imageId: 'img-mysql',
    ports: [{ containerPort: 3306, hostPort: 13307, protocol: 'tcp' }],
    createdAt: before(432), startedAt: before(211),
    command: 'mysqld --default-authentication-plugin=caching_sha2_password',
    env: [{ key: 'MYSQL_DATABASE', value: 'orders' }],
    volumes: [{ hostPath: '/srv/elysian/data/mysql', containerPath: '/var/lib/mysql' }],
    restartPolicy: 'always',
  },
]

/** 运行中容器的初始资源占用（cpuPercent / memMb）。 */
export const INITIAL_CONTAINER_USAGE: Readonly<Record<string, { cpuPercent: number; memMb: number }>> = {
  'ctr-nginx-proxy': { cpuPercent: 12, memMb: 85 },
  'ctr-redis-cache': { cpuPercent: 8, memMb: 512 },
  'ctr-postgres-db': { cpuPercent: 23, memMb: 1840 },
  'ctr-elysian-web': { cpuPercent: 9, memMb: 620 },
  'ctr-elysian-worker': { cpuPercent: 15, memMb: 780 },
  'ctr-log-shipper': { cpuPercent: 4, memMb: 180 },
  'ctr-metrics-agent': { cpuPercent: 6, memMb: 240 },
  'ctr-mariadb-primary': { cpuPercent: 17, memMb: 3277 },
  'ctr-mysql-orders': { cpuPercent: 26, memMb: 4710 },
}

/** 演示状态流动：事件层每 4 拍在这些容器上切换 restarting/running。 */
export const DEMO_CYCLE_CONTAINER_IDS = ['ctr-metrics-agent'] as const

export type ContainerUsage = { containerId: string; cpuPercent: number; memMb: number }

function step(value: number, min: number, max: number, delta: number): number {
  return Math.min(max, Math.max(min, value + Math.round((Math.random() - 0.5) * 2 * delta)))
}

/** 初始占用：全部运行中容器按种子表取值。 */
export function initialContainerUsage(): ContainerUsage[] {
  return CONTAINERS.filter((c) => c.status === 'running').map((c) => ({
    containerId: c.id,
    ...INITIAL_CONTAINER_USAGE[c.id]!,
  }))
}

/** 每拍对运行中容器做资源随机游走；停止/重启中的容器不产生采样。 */
export function walkContainerUsage(
  prev: readonly ContainerUsage[],
  containers: readonly Container[],
): ContainerUsage[] {
  return containers
    .filter((c) => c.status === 'running')
    .map((c) => {
      const base =
        prev.find((p) => p.containerId === c.id) ??
        INITIAL_CONTAINER_USAGE[c.id] ??
        { cpuPercent: 5, memMb: 256 }
      return {
        containerId: c.id,
        cpuPercent: step(base.cpuPercent, 2, 95, 3),
        memMb: step(base.memMb, 128, 4096, 64),
      }
    })
}

export { autoContainerName } from '@elysian/contracts'

/** 确定性伪随机：FNV-1a 32 位哈希，同一输入永远得到同一摘要、标识与体积。 */
export function mockImageArtifact(name: string, tag: string): { id: string; digest: string; sizeMb: number } {
  const input = `${name}:${tag}`
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  const word = (hash >>> 0).toString(16).padStart(8, '0')
  return {
    id: `img-${word}`,
    digest: `sha256:${word}${word.slice(0, 4)}`,
    sizeMb: 8 + ((hash >>> 0) % 448),
  }
}
