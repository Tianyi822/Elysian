import { describe, expect, it } from 'vitest'
import { CONTAINER_IMAGES, CONTAINERS } from '../../adapters/mock/containersData'
import { DATABASE_INSTANCES } from '../../adapters/mock/databaseData'
import {
  containersForEngine,
  emptyDraft,
  generateDemoPassword,
  hasDatabaseCreateErrors,
  toDatabaseCreateInput,
  validateDatabaseCreateDraft,
} from './databaseCreateForm'

describe('添加数据库表单', () => {
  it('必填字段缺失时逐项报错', () => {
    const errors = validateDatabaseCreateDraft(emptyDraft('MariaDB'), DATABASE_INSTANCES, 'MariaDB')

    expect(errors.name).toBe('请填写数据库名')
    expect(errors.username).toBe('请填写用户名')
    expect(errors.password).toBe('请填写密码')
    expect(errors.containerId).toBe('请选择承载容器')
    expect(hasDatabaseCreateErrors(errors)).toBe(true)
  })

  it('同一引擎下重名报错，不同引擎允许同名', () => {
    const draft = { ...emptyDraft('MySQL'), name: 'mariadb-primary', username: 'ops', password: 'x', containerId: 'ctr-mysql-orders' }

    const sameEngine = validateDatabaseCreateDraft(
      { ...draft, name: 'mariadb-primary' },
      DATABASE_INSTANCES,
      'MariaDB',
    )
    expect(sameEngine.name).toBe('该引擎下已有同名数据库')

    const otherEngine = validateDatabaseCreateDraft(draft, DATABASE_INSTANCES, 'MySQL')
    expect(otherEngine.name).toBeUndefined()
  })

  it('名称只允许字母数字下划线与连字符', () => {
    const draft = { ...emptyDraft('MariaDB'), username: 'ops', password: 'x', containerId: 'ctr-mariadb-primary' }

    expect(validateDatabaseCreateDraft({ ...draft, name: 'orders_2' }, DATABASE_INSTANCES, 'MariaDB').name).toBeUndefined()
    expect(validateDatabaseCreateDraft({ ...draft, name: 'orders 2' }, DATABASE_INSTANCES, 'MariaDB').name).toBeDefined()
    expect(validateDatabaseCreateDraft({ ...draft, name: '-orders' }, DATABASE_INSTANCES, 'MariaDB').name).toBeDefined()
  })

  it('承载候选只列运行中且镜像匹配引擎的容器', () => {
    const mariadb = containersForEngine('MariaDB', CONTAINERS, CONTAINER_IMAGES)
    expect(mariadb.map((container) => container.name)).toEqual(['mariadb-primary'])

    const mysql = containersForEngine('MySQL', CONTAINERS, CONTAINER_IMAGES)
    expect(mysql.map((container) => container.name)).toEqual(['mysql-orders'])

    const redis = containersForEngine('Redis', CONTAINERS, CONTAINER_IMAGES)
    expect(redis.map((container) => container.name)).toEqual(['redis-cache'])

    // SQLite 没有对应镜像：候选为空，界面据此禁用提交并说明原因。
    expect(containersForEngine('SQLite', CONTAINERS, CONTAINER_IMAGES)).toEqual([])
  })

  it('toDatabaseCreateInput 收敛草稿：SQL 引擎带字符集，其余引擎省略', () => {
    const draft = {
      name: ' orders_2 ',
      charset: 'utf8mb4',
      username: ' ops ',
      password: 'demo-mysql-0000',
      accessScope: 'any-host',
      containerId: 'ctr-mysql-orders',
    } as const

    const input = toDatabaseCreateInput(draft, 'MySQL')
    expect(input).toEqual({
      engine: 'MySQL',
      name: 'orders_2',
      charset: 'utf8mb4',
      username: 'ops',
      password: 'demo-mysql-0000',
      accessScope: 'any-host',
      containerId: 'ctr-mysql-orders',
    })

    const redisInput = toDatabaseCreateInput(draft, 'Redis')
    expect(redisInput.charset).toBeUndefined()
  })

  it('演示密码为指定长度的字母数字混合', () => {
    const password = generateDemoPassword()
    expect(password).toHaveLength(16)
    expect(password).toMatch(/^[A-Za-z0-9]+$/)
  })
})
