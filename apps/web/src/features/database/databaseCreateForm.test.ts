import { describe, expect, it } from 'vitest'
import { CONTAINER_IMAGES, CONTAINERS } from '../../adapters/mock/containersData'
import { DATABASE_INSTANCES } from '../../adapters/mock/databaseData'
import {
  SQLITE_DATA_DIR,
  containersForEngine,
  databaseNameFromFile,
  emptyDraft,
  generateDemoPassword,
  hasDatabaseCreateErrors,
  sqliteFilePath,
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

  it('toDatabaseCreateInput 收敛草稿：服务型带字符集，Redis 省略字符集', () => {
    const draft = {
      ...emptyDraft('MySQL'),
      name: ' orders_2 ',
      charset: 'utf8mb4',
      username: ' ops ',
      password: 'demo-mysql-0000',
      accessScope: 'any-host',
      containerId: 'ctr-mysql-orders',
    } as const

    const input = toDatabaseCreateInput(draft, 'MySQL')
    expect(input).toEqual({
      kind: 'container',
      engine: 'MySQL',
      name: 'orders_2',
      charset: 'utf8mb4',
      username: 'ops',
      password: 'demo-mysql-0000',
      accessScope: 'any-host',
      containerId: 'ctr-mysql-orders',
    })

    const redisInput = toDatabaseCreateInput(draft, 'Redis')
    expect(redisInput).toMatchObject({ kind: 'container' })
    expect('charset' in redisInput && redisInput.charset).toBeFalsy()
  })

  it('SQLite 走文件支：上传用文件大小，新建是 0 字节空文件', () => {
    const upload = {
      ...emptyDraft('SQLite'),
      name: 'elysian-notes',
      fileSource: 'upload' as const,
      fileName: 'backup.db',
      fileSizeMb: 12.4,
    }
    expect(toDatabaseCreateInput(upload, 'SQLite')).toEqual({
      kind: 'file',
      engine: 'SQLite',
      name: 'elysian-notes',
      filePath: `${SQLITE_DATA_DIR}/backup.db`,
      fileSizeMb: 12.4,
      origin: 'uploaded',
    })

    const created = {
      ...emptyDraft('SQLite'),
      name: 'notes',
      fileSource: 'create' as const,
      directory: '/srv/elysian/data/sqlite',
    }
    expect(toDatabaseCreateInput(created, 'SQLite')).toEqual({
      kind: 'file',
      engine: 'SQLite',
      name: 'notes',
      filePath: '/srv/elysian/data/sqlite/notes.db',
      fileSizeMb: 0,
      origin: 'created',
    })
  })

  it('SQLite 的数据库名即文件名：非法文件名报错，扩展名自动补 .db', () => {
    const base = { ...emptyDraft('SQLite'), fileName: 'notes.db', fileSizeMb: 1 }

    const bad = validateDatabaseCreateDraft({ ...base, name: 'notes/2' }, [], 'SQLite')
    expect(bad.name).toBeDefined()

    const ok = validateDatabaseCreateDraft({ ...base, name: 'notes_2' }, [], 'SQLite')
    expect(ok.name).toBeUndefined()

    // 上传文件名不带扩展名时也补上。
    expect(sqliteFilePath({ ...base, fileName: 'raw', name: 'raw' })).toBe(
      `${SQLITE_DATA_DIR}/raw.db`,
    )
    expect(databaseNameFromFile('backup.db')).toBe('backup')
  })

  it('SQLite 未选文件时给出来源错误，新建时校验落点目录为绝对路径', () => {
    const upload = validateDatabaseCreateDraft(
      { ...emptyDraft('SQLite'), name: 'notes' },
      [],
      'SQLite',
    )
    expect(upload.file).toBe('请拖入或选择一个 .db 文件')

    const created = validateDatabaseCreateDraft(
      { ...emptyDraft('SQLite'), name: 'notes', fileSource: 'create', directory: 'data/sqlite' },
      [],
      'SQLite',
    )
    expect(created.directory).toContain('绝对路径')
  })

  it('演示密码为指定长度的字母数字混合', () => {
    const password = generateDemoPassword()
    expect(password).toHaveLength(16)
    expect(password).toMatch(/^[A-Za-z0-9]+$/)
  })
})
