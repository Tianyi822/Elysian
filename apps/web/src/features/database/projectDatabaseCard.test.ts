import { describe, expect, it } from 'vitest'
import type { Container, DatabaseContainerInstance, DatabaseInstance } from '@elysian/contracts'
import { projectDatabaseCard } from './projectDatabaseCard'

// 投影只消费行自身字段与容器数据集：fixture 内联在测试里，不再依赖演示数据集。
const CONTAINER_ROW: DatabaseContainerInstance = {
  id: 'ctr-mariadb-primary',
  engine: 'MariaDB',
  name: 'mariadb-primary',
  version: '10.11.8',
  status: 'running',
  image: 'mariadb:10.11.8',
  containerId: 'ctr-mariadb-primary',
  source: 'managed',
  versionTag: '10.11.8',
  ports: [{ containerPort: 3306, hostPort: 13306, protocol: 'tcp', hostIp: '127.0.0.1' }],
  networks: ['elysian-db-local'],
  volumeName: 'elysian-db-0f0e0d0c0b0a09080706050403020100',
  address: { host: '127.0.0.1', port: 13306 },
  credentialUsername: 'root',
  credentialsVerified: true,
  needsAttention: false,
  updatedAt: '2026-09-12T08:00:00.000Z',
}

const SQLITE_ROW: DatabaseInstance = {
  id: 'db-sqlite-notes',
  engine: 'SQLite',
  name: 'elysian-notes',
  version: '3.46.1',
  status: 'running',
  filePath: '/srv/elysian/data/sqlite/elysian-notes.db',
  fileSizeMb: 4.2,
  updatedAt: '2026-09-12T08:00:00.000Z',
}

const CONTAINER: Container = {
  id: 'ctr-mariadb-primary',
  name: 'mariadb-primary',
  status: 'running',
  imageId: 'img-mariadb',
  ports: [],
  createdAt: '2026-09-12T08:00:00.000Z',
  command: 'mariadbd',
  env: [],
  volumes: [],
  restartPolicy: 'always',
}

describe('数据库卡片投影', () => {
  it('容器行自带镜像引用，容器数据集用于就地打开详情面板', () => {
    const view = projectDatabaseCard(CONTAINER_ROW, new Map([[CONTAINER.id, CONTAINER]]))
    if (view.kind !== 'container') throw new Error('容器行应投影成容器视图')

    expect(view.imageLabel).toBe('mariadb:10.11.8')
    expect(view.container?.name).toBe('mariadb-primary')
    expect(view.missingContainer).toBe(false)
  })

  it('容器数据集缺失该容器时给出缺失标记而不是空行', () => {
    const view = projectDatabaseCard(CONTAINER_ROW, new Map())
    if (view.kind !== 'container') throw new Error('容器行应投影成容器视图')

    expect(view.container).toBeUndefined()
    expect(view.missingContainer).toBe(true)
  })

  it('文件行（SQLite）按文件路径与大小投影，不涉及容器', () => {
    const view = projectDatabaseCard(SQLITE_ROW, new Map())
    if (view.kind !== 'file') throw new Error('文件行应投影成文件视图')

    expect(view.filePath).toBe('/srv/elysian/data/sqlite/elysian-notes.db')
    expect(view.fileSizeMb).toBe(4.2)
  })

  it('文件行缺路径时投影为空串占位，卡片如实渲染', () => {
    const view = projectDatabaseCard({ ...SQLITE_ROW, filePath: undefined }, new Map())
    if (view.kind !== 'file') throw new Error('文件行应投影成文件视图')

    expect(view.filePath).toBe('')
  })
})
