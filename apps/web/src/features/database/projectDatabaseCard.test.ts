import { describe, expect, it } from 'vitest'
import { CONTAINER_IMAGES, CONTAINERS } from '../../adapters/mock/containersData'
import { DATABASE_INSTANCES } from '../../adapters/mock/databaseData'
import { projectDatabaseCard } from './projectDatabaseCard'

const containerById = new Map(CONTAINERS.map((container) => [container.id, container]))
const imageById = new Map(CONTAINER_IMAGES.map((image) => [image.id, image]))

describe('数据库卡片投影', () => {
  it('服务型按 containerId 取到来源容器的名称与镜像', () => {
    const database = DATABASE_INSTANCES.find((item) => item.engine === 'MariaDB')
    if (!database) throw new Error('演示集里应有 MariaDB 实例')

    const view = projectDatabaseCard(database, containerById, imageById)
    if (view.kind !== 'container') throw new Error('服务型实例应投影成容器来源')

    expect(view.container?.name).toBe('mariadb-primary')
    expect(view.imageLabel).toBe('mariadb:10.11')
    expect(view.missingContainer).toBe(false)
  })

  it('容器缺失时给出缺失标记而不是空行', () => {
    const database = DATABASE_INSTANCES.find((item) => item.engine === 'MariaDB')
    if (!database) throw new Error('演示集里应有 MariaDB 实例')

    const view = projectDatabaseCard(database, new Map(), new Map())
    if (view.kind !== 'container') throw new Error('服务型实例应投影成容器来源')

    expect(view.container).toBeUndefined()
    expect(view.missingContainer).toBe(true)
  })

  it('文件型（SQLite）按文件路径与大小投影，不涉及容器', () => {
    const database = DATABASE_INSTANCES.find((item) => item.engine === 'SQLite')
    if (!database) throw new Error('演示集里应有 SQLite 实例')

    const view = projectDatabaseCard(database, new Map(), new Map())
    if (view.kind !== 'file') throw new Error('文件型实例应投影成文件来源')

    expect(view.filePath).toBe('/srv/elysian/data/sqlite/elysian-notes.db')
    expect(view.fileSizeMb).toBe(4.2)
  })
})
