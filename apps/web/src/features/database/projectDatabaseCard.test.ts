import { describe, expect, it } from 'vitest'
import type { DatabaseInstance } from '@elysian/contracts'
import { CONTAINER_IMAGES, CONTAINERS } from '../../adapters/mock/containersData'
import { projectDatabaseCard } from './projectDatabaseCard'

// 投影只消费实例自身的字段：fixture 内联在测试里，不再依赖演示数据集。
const MARIADB: DatabaseInstance = {
  id: 'db-mariadb-primary',
  engine: 'MariaDB',
  name: 'mariadb-primary',
  version: '10.11.8',
  status: 'running',
  containerId: 'ctr-mariadb-primary',
  updatedAt: '2026-09-12T08:00:00.000Z',
}

const SQLITE: DatabaseInstance = {
  id: 'db-sqlite-notes',
  engine: 'SQLite',
  name: 'elysian-notes',
  version: '3.46.1',
  status: 'running',
  filePath: '/srv/elysian/data/sqlite/elysian-notes.db',
  fileSizeMb: 4.2,
  updatedAt: '2026-09-12T08:00:00.000Z',
}

const containerById = new Map(CONTAINERS.map((container) => [container.id, container]))
const imageById = new Map(CONTAINER_IMAGES.map((image) => [image.id, image]))

describe('数据库卡片投影', () => {
  it('服务型按 containerId 取到来源容器的名称与镜像', () => {
    const view = projectDatabaseCard(MARIADB, containerById, imageById)
    if (view.kind !== 'container') throw new Error('服务型实例应投影成容器来源')

    expect(view.container?.name).toBe('mariadb-primary')
    expect(view.imageLabel).toBe('mariadb:10.11')
    expect(view.missingContainer).toBe(false)
  })

  it('容器缺失时给出缺失标记而不是空行', () => {
    const view = projectDatabaseCard(MARIADB, new Map(), new Map())
    if (view.kind !== 'container') throw new Error('服务型实例应投影成容器来源')

    expect(view.container).toBeUndefined()
    expect(view.missingContainer).toBe(true)
  })

  it('文件型（SQLite）按文件路径与大小投影，不涉及容器', () => {
    const view = projectDatabaseCard(SQLITE, new Map(), new Map())
    if (view.kind !== 'file') throw new Error('文件型实例应投影成文件来源')

    expect(view.filePath).toBe('/srv/elysian/data/sqlite/elysian-notes.db')
    expect(view.fileSizeMb).toBe(4.2)
  })
})
