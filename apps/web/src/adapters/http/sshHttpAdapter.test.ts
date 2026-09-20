import { describe, expect, it } from 'vitest'
import {
  parseSshKeyAccountsResponse,
  parseSshKeyListResponse,
  parseSshKeyResponse,
  parseSshLoginRecordsResponse,
  parseSshOverviewResponse,
  parseSshPasswordResetResponse,
  parseSshRootAuthResponse,
  parseSshSettingsResponse,
} from './sshHttpAdapter'

/*
 * 纯解析函数的契约测试：只校验 JSON 形状窄化与中文错误，不发任何真实请求。
 * 响应样例与 sshHost/api.ts 的返回形状一致。
 */

describe('parseSshOverviewResponse', () => {
  const valid = {
    enabled: true,
    status: 'running',
    changedAt: null,
    stats: {
      today: { succeeded: 205, failed: 3147 },
      yesterday: { succeeded: 198, failed: 2890 },
      last7Days: { succeeded: 1382, failed: 18499 },
    },
  }

  it('接受开关、状态、上次变更与三窗口统计', () => {
    const overview = parseSshOverviewResponse(valid)
    expect(overview).toEqual(valid)
  })

  it('非对象、坏开关、坏状态、坏时间时抛中文错误', () => {
    expect(() => parseSshOverviewResponse(null)).toThrow('SSH 响应格式无效')
    expect(() => parseSshOverviewResponse({ ...valid, enabled: 'yes' })).toThrow('SSH 服务开关响应无效')
    expect(() => parseSshOverviewResponse({ ...valid, status: 'unknown' })).toThrow('SSH 服务状态响应无效')
    expect(() => parseSshOverviewResponse({ ...valid, changedAt: 123 })).toThrow('SSH 上次变更时间响应无效')
  })

  it('统计窗口缺失或计数不是数字时按窗口报错', () => {
    expect(() => parseSshOverviewResponse({ ...valid, stats: { today: { succeeded: 1 } } })).toThrow(
      'SSH 登录统计响应无效：今日',
    )
    expect(() =>
      parseSshOverviewResponse({ ...valid, stats: { today: {}, yesterday: {}, last7Days: {} } }),
    ).toThrow('SSH 登录统计响应无效：今日')
    expect(() =>
      parseSshOverviewResponse({
        ...valid,
        stats: { today: { succeeded: 1, failed: 2 }, yesterday: { succeeded: 1, failed: 2 }, last7Days: null },
      }),
    ).toThrow('SSH 登录统计响应无效：近 7 天')
  })
})

describe('parseSshSettingsResponse', () => {
  it('接受登录方式开关与监听端口', () => {
    expect(parseSshSettingsResponse({ passwordAuthEnabled: false, keyAuthEnabled: true, port: 73 })).toEqual(
      { passwordAuthEnabled: false, keyAuthEnabled: true, port: 73 },
    )
  })

  it('开关或端口类型不对时抛中文错误', () => {
    expect(() => parseSshSettingsResponse({ passwordAuthEnabled: true, keyAuthEnabled: true })).toThrow(
      'SSH 登录设置响应无效',
    )
    expect(() =>
      parseSshSettingsResponse({ passwordAuthEnabled: 'no', keyAuthEnabled: true, port: 22 }),
    ).toThrow('SSH 登录设置响应无效')
    expect(() => parseSshSettingsResponse({ passwordAuthEnabled: true, keyAuthEnabled: true, port: '22' })).toThrow(
      'SSH 登录设置响应无效',
    )
  })
})

describe('parseSshRootAuthResponse', () => {
  it('接受策略、密钥材料与密码重置时间；authorized_keys 为空时 key 为 null', () => {
    const withKey = parseSshRootAuthResponse({
      policy: 'prohibit-password',
      key: {
        algorithm: 'ssh-ed25519 256',
        fingerprint: 'SHA256:abc',
        createdAt: '2026-01-02T03:04:05Z',
        publicKey: 'ssh-ed25519 AAAA ops@elysian',
      },
      passwordResetAt: null,
    })
    expect(withKey.key).toMatchObject({ algorithm: 'ssh-ed25519 256', fingerprint: 'SHA256:abc' })

    const withoutKey = parseSshRootAuthResponse({ policy: 'no', key: null, passwordResetAt: '2026-01-02T03:04:05Z' })
    expect(withoutKey).toEqual({ policy: 'no', key: null, passwordResetAt: '2026-01-02T03:04:05Z' })
  })

  it('生成响应经同一解析器放行，私钥在此时一次性携带', () => {
    const generated = parseSshRootAuthResponse({
      policy: 'prohibit-password',
      key: {
        algorithm: 'ssh-ed25519 256',
        fingerprint: 'SHA256:abc',
        createdAt: '2026-01-02T03:04:05Z',
        publicKey: 'ssh-ed25519 AAAA elysian-root',
        privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\n占位\n-----END OPENSSH PRIVATE KEY-----',
      },
      passwordResetAt: null,
    })
    expect(generated.key?.privateKey).toContain('BEGIN OPENSSH PRIVATE KEY')
    // 同一解析器对查看响应（无私钥）也放行：字段可缺省。
    expect(parseSshRootAuthResponse({ ...generated, key: { ...generated.key!, privateKey: undefined } }).key?.privateKey).toBeUndefined()
  })

  it('坏策略、坏时间或缺字段时抛中文错误', () => {
    expect(() => parseSshRootAuthResponse({ policy: 'maybe', key: null, passwordResetAt: null })).toThrow(
      'SSH Root 登录策略响应无效',
    )
    expect(() => parseSshRootAuthResponse({ policy: 'no', key: null, passwordResetAt: 1 })).toThrow(
      'SSH Root 密码重置时间响应无效',
    )
    expect(() =>
      parseSshRootAuthResponse({ policy: 'no', key: { algorithm: 1 }, passwordResetAt: null }),
    ).toThrow('SSH 密钥材料响应无效')
  })
})

describe('parseSshPasswordResetResponse', () => {
  it('接受重置后的凭据快照与强度档位', () => {
    const result = parseSshPasswordResetResponse({
      auth: { policy: 'no', key: null, passwordResetAt: '2026-01-02T03:04:05Z' },
      strength: 'strong',
    })
    expect(result.strength).toBe('strong')
    expect(result.auth.passwordResetAt).toBe('2026-01-02T03:04:05Z')
  })

  it('强度取值不在契约枚举里时抛中文错误', () => {
    expect(() =>
      parseSshPasswordResetResponse({ auth: { policy: 'no', key: null, passwordResetAt: null }, strength: 'ok' }),
    ).toThrow('SSH 密码强度响应无效')
  })
})

describe('parseSshKeyListResponse 与 parseSshKeyResponse', () => {
  const keyRow = {
    id: 'SHA256:abc',
    name: '部署机',
    userId: 'ops',
    algorithm: 'ssh-ed25519 256',
    fingerprint: 'SHA256:abc',
    createdAt: '2026-01-02T03:04:05Z',
    publicKey: 'ssh-ed25519 AAAA elysian-部署机',
  }

  it('列表接受密钥数组，条目缺字段时抛中文错误', () => {
    const keys = parseSshKeyListResponse({ keys: [keyRow] })
    expect(keys).toEqual([{ ...keyRow, privateKey: undefined }])
    expect(() => parseSshKeyListResponse({ keys: 'nope' })).toThrow('SSH 密钥列表响应无效：应为数组')
    expect(() => parseSshKeyListResponse({ keys: [{ ...keyRow, userId: 7 }] })).toThrow('SSH 密钥条目响应无效')
  })

  it('创建响应接受单把密钥，私钥仅在此时携带', () => {
    const created = parseSshKeyResponse({ key: { ...keyRow, privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\n' } })
    expect(created.privateKey).toContain('BEGIN OPENSSH PRIVATE KEY')
    expect(parseSshKeyResponse({ key: keyRow }).privateKey).toBeUndefined()
    expect(() => parseSshKeyResponse({})).toThrow('SSH 响应格式无效')
  })
})

describe('parseSshKeyAccountsResponse', () => {
  it('接受归属账号清单；mock 与真实实现同形（id 加展示名）', () => {
    expect(parseSshKeyAccountsResponse({ accounts: [{ id: 'ops', name: 'ops' }] })).toEqual([
      { id: 'ops', name: 'ops' },
    ])
  })

  it('缺数组或条目字段类型不对时抛中文错误', () => {
    expect(() => parseSshKeyAccountsResponse({ accounts: null })).toThrow('SSH 归属账号响应无效：应为数组')
    expect(() => parseSshKeyAccountsResponse({ accounts: [{ id: 'ops' }] })).toThrow('SSH 归属账号条目响应无效')
    expect(() => parseSshKeyAccountsResponse({ accounts: [{ id: 1, name: 'ops' }] })).toThrow(
      'SSH 归属账号条目响应无效',
    )
  })
})

describe('parseSshLoginRecordsResponse', () => {
  it('接受登录记录数组，成功与失败两种结果都放行', () => {
    const records = parseSshLoginRecordsResponse({
      records: [
        { id: 'login-1', ip: '127.0.0.1', port: 43462, at: '2026-01-02T03:04:05Z', user: 'root', result: 'succeeded' },
        { id: 'login-2', ip: '45.155.205.233', port: 51422, at: '2026-01-02T03:05:05Z', user: 'root', result: 'failed' },
      ],
    })
    expect(records.map((record) => record.result)).toEqual(['succeeded', 'failed'])
  })

  it('缺数组或条目不完整时抛中文错误', () => {
    expect(() => parseSshLoginRecordsResponse({})).toThrow('SSH 登录记录响应无效：应为数组')
    expect(() => parseSshLoginRecordsResponse({ records: [{ id: 'login-1', result: 'ok' }] })).toThrow(
      'SSH 登录记录条目响应无效',
    )
  })
})
