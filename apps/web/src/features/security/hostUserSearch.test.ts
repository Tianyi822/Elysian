import { describe, expect, it } from 'vitest'
import type { HostUser } from '@elysian/contracts'
import { filterHostUsers, matchesHostUser, normalizeUserSearch } from './hostUserSearch'

const WANGWU: HostUser = {
  id: 'user-wangwu',
  name: 'wangwu',
  isAdmin: false,
  loginMethod: 'key',
  status: 'active',
  note: '运维值班账号',
  createdAt: '2025-03-12T09:20:14+08:00',
}

const BACKUP: HostUser = {
  ...WANGWU,
  id: 'user-backup',
  name: 'backup',
  note: '只跑备份脚本，不允许登录',
}

const USERS: readonly HostUser[] = [WANGWU, BACKUP]

describe('账号搜索', () => {
  it('关键词归一化：去掉全部空白并统一小写', () => {
    expect(normalizeUserSearch('  WANG wu  ')).toBe('wangwu')
  })

  it('按用户名命中，大小写不敏感', () => {
    expect(filterHostUsers('WANGWU', USERS)).toEqual([WANGWU])
    expect(filterHostUsers('back', USERS)).toEqual([BACKUP])
  })

  it('按备注命中，带不带空格都能命中', () => {
    expect(filterHostUsers('备份', USERS)).toEqual([BACKUP])
    expect(filterHostUsers('只跑 备份脚本', USERS)).toEqual([BACKUP])
  })

  it('备注为空的账号不会因为空串命中', () => {
    expect(matchesHostUser('运维', { ...WANGWU, note: null })).toBe(false)
  })

  it('关键词为空时返回全部，搜不到时返回空列表', () => {
    expect(filterHostUsers('   ', USERS)).toEqual(USERS)
    expect(filterHostUsers('不存在的人', USERS)).toEqual([])
  })
})
