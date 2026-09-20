import { describe, expect, it } from 'vitest'
import {
  parseHostUser,
  parseHostUserListResponse,
  parseHostUserRemoveResponse,
  parseHostUserResponse,
  parseHostUserSyncResponse,
} from './usersHttpAdapter'

/*
 * 纯解析函数的契约测试：只校验 JSON 形状窄化与中文错误，不发任何真实请求。
 * 响应样例与 usersHost/api.ts 的返回形状一致——真实实现的 createdAt 恒为 null，
 * mock 侧是种子时间字符串，两者都必须放行（契约允许 string|null）。
 */

const realUserRow = {
  id: 'chenyi',
  name: 'chenyi',
  isAdmin: true,
  loginMethod: 'password-or-key',
  status: 'active',
  note: null,
  createdAt: null,
}

const mockUserRow = {
  id: 'user-ops',
  name: 'ops',
  isAdmin: true,
  loginMethod: 'key',
  status: 'active',
  note: '运维值班账号',
  createdAt: '2026-01-02T03:04:05Z',
}

describe('parseHostUser', () => {
  it('接受真实实现条目：createdAt 为 null 也放行', () => {
    expect(parseHostUser(realUserRow)).toEqual(realUserRow)
  })

  it('接受 mock 同形条目：createdAt 为 ISO 字符串、note 为中文备注', () => {
    expect(parseHostUser(mockUserRow)).toEqual(mockUserRow)
  })

  it('非对象、缺字段或类型不对时抛中文错误', () => {
    expect(() => parseHostUser(null)).toThrow('主机账号响应格式无效')
    expect(() => parseHostUser('ops')).toThrow('主机账号响应格式无效')
    expect(() => parseHostUser({ ...realUserRow, isAdmin: 'yes' })).toThrow('主机账号条目响应无效')
    expect(() => parseHostUser({ ...realUserRow, name: 7 })).toThrow('主机账号条目响应无效')
  })

  it('登录方式与状态取值不在契约枚举里时按字段报错', () => {
    expect(() => parseHostUser({ ...realUserRow, loginMethod: 'fingerprint' })).toThrow(
      '主机账号登录方式响应无效',
    )
    expect(() => parseHostUser({ ...realUserRow, status: 'locked' })).toThrow('主机账号状态响应无效')
  })

  it('note 与 createdAt 只接受 string 或 null，其余类型抛中文错误', () => {
    expect(() => parseHostUser({ ...realUserRow, note: 3 })).toThrow('主机账号备注响应无效')
    expect(() => parseHostUser({ ...realUserRow, createdAt: 20260102 })).toThrow(
      '主机账号创建时间响应无效',
    )
    // null 两个字段都放行：真实实现 note 与 createdAt 都可能是 null。
    expect(parseHostUser({ ...realUserRow, note: null, createdAt: null })).toEqual(realUserRow)
  })
})

describe('parseHostUserListResponse', () => {
  it('接受账号数组，逐条校验', () => {
    const users = parseHostUserListResponse({ users: [mockUserRow, realUserRow] })
    expect(users).toHaveLength(2)
    expect(users[0]).toEqual(mockUserRow)
    expect(users[1]).toEqual(realUserRow)
  })

  it('缺数组或条目坏时抛中文错误', () => {
    expect(() => parseHostUserListResponse({})).toThrow('主机账号列表响应无效：应为数组')
    expect(() => parseHostUserListResponse({ users: 'nope' })).toThrow('主机账号列表响应无效：应为数组')
    expect(() => parseHostUserListResponse({ users: [{ ...realUserRow, loginMethod: 'both' }] })).toThrow(
      '主机账号登录方式响应无效',
    )
  })
})

describe('parseHostUserResponse', () => {
  it('接受写操作后回读出的那一个账号（创建与修改同形）', () => {
    expect(parseHostUserResponse({ user: realUserRow })).toEqual(realUserRow)
  })

  it('缺 user 或 user 非对象时抛中文错误', () => {
    expect(() => parseHostUserResponse({})).toThrow('主机账号响应格式无效')
    expect(() => parseHostUserResponse({ user: null })).toThrow('主机账号响应格式无效')
  })
})

describe('parseHostUserRemoveResponse', () => {
  it('接受 { ok: true }，其余形状抛中文错误', () => {
    expect(parseHostUserRemoveResponse({ ok: true })).toBeUndefined()
    expect(() => parseHostUserRemoveResponse({ ok: false })).toThrow('主机账号删除响应无效')
    expect(() => parseHostUserRemoveResponse(null)).toThrow('主机账号响应格式无效')
  })
})

describe('parseHostUserSyncResponse', () => {
  it('接受同步后的账号总数，非数字抛中文错误', () => {
    expect(parseHostUserSyncResponse({ total: 5 })).toEqual({ total: 5 })
    expect(() => parseHostUserSyncResponse({ total: '5' })).toThrow('主机账号同步响应无效')
    expect(() => parseHostUserSyncResponse({})).toThrow('主机账号同步响应无效')
  })
})
