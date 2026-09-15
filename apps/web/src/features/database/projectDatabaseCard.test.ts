import { describe, expect, it } from 'vitest'
import { CONTAINER_IMAGES, CONTAINERS } from '../../adapters/mock/containersData'
import { DATABASE_INSTANCES } from '../../adapters/mock/databaseData'
import { projectDatabaseCard } from './projectDatabaseCard'

const baseTime = new Date('2026-09-15T00:00:00.000Z')
const containerById = new Map(CONTAINERS.map((container) => [container.id, container]))
const imageById = new Map(CONTAINER_IMAGES.map((image) => [image.id, image]))

describe('数据库卡片投影', () => {
  it('按 containerId 取到来源容器的名称、镜像与运行时长', () => {
    const database = DATABASE_INSTANCES.find((item) => item.engine === 'MariaDB')
    if (!database) throw new Error('演示集里应有 MariaDB 实例')

    const view = projectDatabaseCard(database, containerById, imageById, baseTime)

    expect(view.container?.name).toBe('mariadb-primary')
    expect(view.imageLabel).toBe('mariadb:10.11')
    expect(view.uptimeLabel).toMatch(/^运行 /)
    expect(view.missingContainer).toBe(false)
  })

  it('容器缺失时给出缺失标记而不是空行', () => {
    const database = DATABASE_INSTANCES[0]
    if (!database) throw new Error('演示集不应为空')

    const view = projectDatabaseCard(database, new Map(), new Map(), baseTime)

    expect(view.container).toBeUndefined()
    expect(view.missingContainer).toBe(true)
  })
})
