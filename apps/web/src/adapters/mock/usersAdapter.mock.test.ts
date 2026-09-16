import { beforeEach, describe, expect, it } from 'vitest'
import type { UserAdapter } from '../../contracts/adapters'
import { MockSshAdapter, MockUserAdapter } from './mockAdapters'
import { SEED_LOGIN_KEYS, resetSshData } from './sshData'
import { SEED_HOST_USERS, resetHostUsers } from './usersData'

/*
 * 主机账号 mock adapter 的行为：种子账号、创建、修改、删除与账号和密钥之间的联动。
 * 演示数据集是模块级内存状态，每个用例前把两份数据集都推回种子，用例之间互不影响。
 */

let users: UserAdapter

beforeEach(() => {
  resetHostUsers()
  resetSshData()
  users = new MockUserAdapter()
})

describe('主机账号 mock adapter', () => {
  it('种子：八个账号，按创建时间倒序，管理员与禁止登录各有一例', async () => {
    const list = await users.list()

    expect(list).toHaveLength(SEED_HOST_USERS.length)
    expect(list.map((user) => user.name)).toEqual([
      'deploy',
      'monitor',
      'lisi',
      'wangwu',
      'zhangsan',
      'ops',
      'backup',
      'audit',
    ])
    const createdAt = list.map((user) => new Date(user.createdAt).getTime())
    expect([...createdAt].sort((a, b) => b - a)).toEqual(createdAt)
    expect(list.find((user) => user.name === 'ops')?.isAdmin).toBe(true)
    // 账号正常但禁止登录：与「账号已停用」是两回事
    expect(list.find((user) => user.name === 'backup')).toMatchObject({
      loginMethod: 'none',
      status: 'active',
    })
    expect(list.find((user) => user.name === 'zhangsan')?.status).toBe('disabled')
  })

  it('创建账号：用户名按 Linux 规则校验，重名被拒，新账号排在列表最前', async () => {
    const created = await users.create({
      name: 'chenyi',
      loginMethod: 'key',
      status: 'active',
      isAdmin: false,
      note: '新同事',
    })

    expect(created).toMatchObject({ id: 'user-chenyi', name: 'chenyi', note: '新同事' })
    expect(created.createdAt).not.toBe('')
    expect((await users.list())[0]?.name).toBe('chenyi')

    await expect(
      users.create({ name: 'chenyi', loginMethod: 'key', status: 'active', isAdmin: false, note: null }),
    ).rejects.toThrow('用户名已存在：chenyi')
    await expect(
      users.create({ name: 'ChenYi', loginMethod: 'key', status: 'active', isAdmin: false, note: null }),
    ).rejects.toThrow('用户名只能用小写字母')
    await expect(
      users.create({ name: '2ops', loginMethod: 'key', status: 'active', isAdmin: false, note: null }),
    ).rejects.toThrow('用户名只能用小写字母')
  })

  it('修改账号：只改认证方式、状态、管理员归属与备注，用户名与创建时间不动', async () => {
    const target = SEED_HOST_USERS.find((user) => user.name === 'wangwu')!
    const updated = await users.update(target.id, {
      loginMethod: 'password-or-key',
      status: 'disabled',
      isAdmin: true,
      note: '临时提权',
    })

    expect(updated).toMatchObject({
      id: target.id,
      name: 'wangwu',
      createdAt: target.createdAt,
      loginMethod: 'password-or-key',
      status: 'disabled',
      isAdmin: true,
      note: '临时提权',
    })
    expect((await users.list()).find((user) => user.id === target.id)).toEqual(updated)

    await expect(
      users.update('user-不存在', {
        loginMethod: 'key',
        status: 'active',
        isAdmin: false,
        note: null,
      }),
    ).rejects.toThrow('未找到主机账号 user-不存在')
  })

  it('删除账号：不存在的 id 报中文错，存在的从列表消失', async () => {
    const target = SEED_HOST_USERS[0]!
    await users.remove(target.id)

    expect((await users.list()).map((user) => user.id)).not.toContain(target.id)
    await expect(users.remove('user-不存在')).rejects.toThrow('未找到主机账号 user-不存在')
  })

  it('删除账号：以它授权的密钥一并失效，不留没有主人的密钥', async () => {
    const ssh = new MockSshAdapter()
    const owned = (await ssh.listKeys()).filter((key) => key.userId === 'user-ops')
    expect(owned.length).toBeGreaterThan(0)

    await users.remove('user-ops')

    const remaining = await ssh.listKeys()
    expect(remaining.some((key) => key.userId === 'user-ops')).toBe(false)
    expect(remaining).toHaveLength(SEED_LOGIN_KEYS.length - owned.length)
  })

  it('取回的是副本：改它不会写回数据集', async () => {
    const list = await users.list()
    list[0]!.name = '被改过了'
    expect((await users.list())[0]!.name).toBe(SEED_HOST_USERS[0]!.name)
  })
})
