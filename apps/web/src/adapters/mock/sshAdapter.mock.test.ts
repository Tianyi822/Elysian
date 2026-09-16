import { beforeEach, describe, expect, it } from 'vitest'
import type { SshAdapter } from '../../contracts/adapters'
import { MockSshAdapter } from './mockAdapters'
import {
  SEED_LOGIN_KEYS,
  SEED_LOGIN_RECORDS,
  SEED_SSH_PORT,
  SEED_SSH_STATS,
  mockKeyMaterial,
  resetSshData,
} from './sshData'

/*
 * SSH mock adapter 的行为：种子状态、启停服务、登录方式与端口、Root 策略与密码重置。
 * 演示数据集是模块级内存状态，每个用例前推回种子，用例之间互不影响。
 */

let ssh: SshAdapter

beforeEach(() => {
  resetSshData()
  ssh = new MockSshAdapter()
})

describe('SSH mock adapter', () => {
  it('种子：服务运行中、密码登录关闭、密钥登录开启、端口 73、没有变更记录', async () => {
    const [overview, settings, rootAuth] = await Promise.all([
      ssh.overview(),
      ssh.settings(),
      ssh.rootAuth(),
    ])

    expect(overview).toMatchObject({ enabled: true, status: 'running', changedAt: null })
    expect(overview.stats).toEqual(SEED_SSH_STATS)
    expect(settings).toEqual({ passwordAuthEnabled: false, keyAuthEnabled: true, port: SEED_SSH_PORT })
    expect(rootAuth.policy).toBe('prohibit-password')
    expect(rootAuth.passwordResetAt).toBeNull()
  })

  it('启停服务改状态与变更时间，登录统计本身不动', async () => {
    const stopped = await ssh.setServiceEnabled(false)
    expect(stopped).toMatchObject({ enabled: false, status: 'stopped' })
    expect(stopped.changedAt).not.toBeNull()
    expect(stopped.stats).toEqual(SEED_SSH_STATS)
    expect((await ssh.setServiceEnabled(true)).status).toBe('running')
  })

  it('登录方式与端口分别保存，互不覆盖', async () => {
    const afterMethods = await ssh.setAuthMethods({ passwordAuthEnabled: true, keyAuthEnabled: true })
    expect(afterMethods).toEqual({
      passwordAuthEnabled: true,
      keyAuthEnabled: true,
      port: SEED_SSH_PORT,
    })

    const afterPort = await ssh.setPort(2222)
    expect(afterPort).toEqual({ passwordAuthEnabled: true, keyAuthEnabled: true, port: 2222 })
    expect(await ssh.settings()).toEqual(afterPort)
  })

  it('端口判据与契约同源：非法端口被拒绝，数据集不变', async () => {
    await expect(ssh.setPort(0)).rejects.toThrow('SSH 端口需为 1-65535 的整数')
    await expect(ssh.setPort(65536)).rejects.toThrow()
    await expect(ssh.setPort(22.5)).rejects.toThrow()
    expect((await ssh.settings()).port).toBe(SEED_SSH_PORT)
  })

  it('弱密码被拒绝且不留重置时间，达标的密码通过并记下重置时间', async () => {
    await expect(ssh.resetRootPassword('abcdefgh')).rejects.toThrow('密码强度不足')
    expect((await ssh.rootAuth()).passwordResetAt).toBeNull()

    const result = await ssh.resetRootPassword('Elysian#2026Root')
    expect(result.strength).toBe('strong')
    expect(result.auth.passwordResetAt).not.toBeNull()
    expect((await ssh.rootAuth()).passwordResetAt).toBe(result.auth.passwordResetAt)
  })

  it('Root 登录策略可改，密钥材料始终是演示种子', async () => {
    const saved = await ssh.saveRootLoginPolicy('no')
    expect(saved.policy).toBe('no')
    expect((await ssh.rootAuth()).policy).toBe('no')

    const { key } = await ssh.rootAuth()
    expect(key.fingerprint.startsWith('SHA256:')).toBe(true)
    expect(key.algorithm).toBe('ssh-ed25519 256')
    expect(key.privateKey.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----')).toBe(true)
  })

  it('取回的是副本：改它不会写回数据集', async () => {
    const overview = await ssh.overview()
    overview.stats.today.succeeded = -1
    expect((await ssh.overview()).stats.today.succeeded).toBe(SEED_SSH_STATS.today.succeeded)

    const rootAuth = await ssh.rootAuth()
    rootAuth.key.fingerprint = 'SHA256:被改过了'
    expect((await ssh.rootAuth()).key.fingerprint).not.toBe('SHA256:被改过了')

    const keys = await ssh.listKeys()
    keys[0]!.name = '被改过了'
    expect((await ssh.listKeys())[0]!.name).toBe(SEED_LOGIN_KEYS[0]!.name)
  })

  it('登录密钥种子四把，材料按名称确定性派生', async () => {
    const keys = await ssh.listKeys()
    expect(keys.map((key) => key.name)).toEqual(SEED_LOGIN_KEYS.map((key) => key.name))

    for (const key of keys) {
      expect(key.fingerprint.startsWith('SHA256:')).toBe(true)
      expect(key.publicKey).toContain(key.name)
      expect(key.privateKey.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----')).toBe(true)
    }
  })

  it('创建密钥：名称去空白后入列，空名与重名被拒，同名同刻生成同一份材料', async () => {
    const created = await ssh.createKey({ name: '  运维笔记本  ' })
    expect(created.name).toBe('运维笔记本')
    expect((await ssh.listKeys()).map((key) => key.name)).toContain('运维笔记本')

    await expect(ssh.createKey({ name: '运维笔记本' })).rejects.toThrow('密钥名称已存在：运维笔记本')
    await expect(ssh.createKey({ name: '   ' })).rejects.toThrow('密钥名称需为 1-32 个字符')
    await expect(ssh.createKey({ name: 'x'.repeat(33) })).rejects.toThrow('密钥名称需为 1-32 个字符')

    const again = mockKeyMaterial('运维笔记本', created.createdAt)
    expect(again.fingerprint).toBe(created.fingerprint)
    expect(again.publicKey).toBe(created.publicKey)
  })

  it('删除密钥：不存在的 id 报中文错，存在的从列表消失', async () => {
    const target = SEED_LOGIN_KEYS[0]!
    await ssh.removeKey(target.id)

    expect((await ssh.listKeys()).map((key) => key.id)).not.toContain(target.id)
    await expect(ssh.removeKey('key-不存在')).rejects.toThrow('未找到登录密钥 key-不存在')
  })

  it('登录记录：按时间倒序给出，含来源地址、客户端端口、账号与结果', async () => {
    const records = await ssh.listLoginRecords()

    expect(records).toEqual(SEED_LOGIN_RECORDS)
    const times = records.map((record) => new Date(record.at).getTime())
    expect([...times].sort((a, b) => b - a)).toEqual(times)
    expect(records[0]).toMatchObject({ ip: '1.204.32.143', port: 16999, user: 'root', result: 'succeeded' })
    // 成功与失败两种结果都在种子里，状态列因此不是摆设
    expect(records.some((record) => record.result === 'failed')).toBe(true)
  })
})
