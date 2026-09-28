import { describe, expect, it } from 'vitest'
import type { DatabaseInstance } from '@elysian/contracts'
import {
  databaseNameFromFile,
  emptyDraft,
  generateDemoPassword,
  hasDatabaseCreateErrors,
  toDatabaseCreateInput,
  validateDatabaseCreateDraft,
} from './databaseCreateForm'

// 重名校验只消费引擎与名称：已存在实例内联在测试里，不再依赖演示数据集。
const EXISTING: readonly DatabaseInstance[] = [
  { id: 'db-sqlite-notes', engine: 'SQLite', name: 'elysian-notes', version: '3.46.1', status: 'running', source: 'managed', updatedAt: '2026-09-12T08:00:00.000Z' },
]

describe('添加 SQLite 数据库表单', () => {
  it('必填字段缺失时逐项报错', () => {
    const errors = validateDatabaseCreateDraft(emptyDraft(), EXISTING)

    expect(errors.name).toBe('请填写数据库名')
    expect(errors.file).toBe('请拖入或选择一个 .db 文件')
    expect(hasDatabaseCreateErrors(errors)).toBe(true)
  })

  it('同名 SQLite 数据库报错', () => {
    const draft = { ...emptyDraft(), name: 'elysian-notes', fileName: 'notes.db' }

    expect(validateDatabaseCreateDraft(draft, EXISTING).name).toBe('该引擎下已有同名数据库')

    const other = validateDatabaseCreateDraft({ ...draft, name: 'notes_2' }, EXISTING)
    expect(other.name).toBeUndefined()
  })

  it('数据库名即文件名：非法文件名报错', () => {
    const base = { ...emptyDraft(), fileName: 'notes.db', fileSizeMb: 1 }

    const bad = validateDatabaseCreateDraft({ ...base, name: 'notes/2' }, [])
    expect(bad.name).toBeDefined()

    const ok = validateDatabaseCreateDraft({ ...base, name: 'notes_2' }, [])
    expect(ok.name).toBeUndefined()
  })

  it('toDatabaseCreateInput 只产出服务端需要的字段：上传与新建两态', () => {
    const upload = {
      ...emptyDraft(),
      name: ' elysian-notes ',
      fileSource: 'upload' as const,
      fileName: 'backup.db',
      fileSizeMb: 12.4,
    }
    expect(toDatabaseCreateInput(upload)).toEqual({
      kind: 'file',
      engine: 'SQLite',
      name: 'elysian-notes',
      origin: 'uploaded',
    })

    const created = {
      ...emptyDraft(),
      name: 'notes',
      fileSource: 'create' as const,
    }
    expect(toDatabaseCreateInput(created)).toEqual({
      kind: 'file',
      engine: 'SQLite',
      name: 'notes',
      origin: 'created',
    })

    // 客户端不报送路径与大小：真实链路里两者由服务端决定，自报字段会被整体丢弃。
    const input = toDatabaseCreateInput(upload)
    expect('filePath' in input).toBe(false)
    expect('fileSizeMb' in input).toBe(false)
  })

  it('文件名去掉扩展名后就是数据库名，扩展名自动补 .db', () => {
    expect(databaseNameFromFile('backup.db')).toBe('backup')
    expect(databaseNameFromFile('backup.sqlite3')).toBe('backup')
    expect(databaseNameFromFile('raw')).toBe('raw')
  })

  it('演示密码为指定长度的字母数字混合', () => {
    const password = generateDemoPassword()
    expect(password).toHaveLength(16)
    expect(password).toMatch(/^[A-Za-z0-9]+$/)
  })
})
