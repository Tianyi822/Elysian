import { describe, expect, it } from 'vitest'
import {
  daysSinceEpochUtc,
  deriveHostUser,
  isManagedUid,
  keyUsable,
  loginMethodOf,
  noteOfGecos,
  parseGetentPasswd,
  parseGetentShadow,
  parseGroupMembers,
  parsePasswdLine,
  parseShadowLine,
  passwordUsable,
  statusOf,
} from './parseSystemUsers'

/*
 * 解析器夹具单测：passwd/shadow/group 样本到视图模型的推导。
 * 形状对齐容器 ubuntu:24.04 的真实输出（getent 逐库输出冒号分隔行）。
 */

/** 本地时构造基准时间：过期判定与机器时区无关。 */
const NOW = new Date(2026, 8, 20, 12, 0, 0).toISOString()

const PASSWD_SAMPLE = [
  'root:x:0:0:root:/root:/bin/bash',
  'ubuntu:x:1000:1000:Ubuntu User:/home/ubuntu:/bin/bash',
  'elysian:x:1001:1001:Elysian 面板账号:/home/elysian:/bin/bash',
  'svc:x:999:999::/home/svc:/usr/sbin/nologin',
  'daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin',
  'nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin',
].join('\n')

const SHADOW_SAMPLE = [
  'root:$6$roothash…:20000:0:99999:7:::',
  'ubuntu:$6$ubuntuhash…:20050:0:99999:7:::',
  'elysian:!:20040:0:99999:7:::',
  'svc:*:20010:0:99999:7:::',
].join('\n')

const SUDO_GROUP_SAMPLE = 'sudo:x:27:ubuntu,elysian\n'

describe('passwd 解析', () => {
  it('解析全部字段，含 GECOS 与 shell；无法辨认的行跳过', () => {
    const records = parseGetentPasswd(`${PASSWD_SAMPLE}\n坏行\n`)
    expect(records).toHaveLength(6)
    expect(records[1]).toEqual({
      name: 'ubuntu',
      uid: 1000,
      gid: 1000,
      gecos: 'Ubuntu User',
      home: '/home/ubuntu',
      shell: '/bin/bash',
    })
    expect(parsePasswdLine('elysian:x:1001:1001::/home/elysian:/bin/bash')?.gecos).toBe('')
    expect(parsePasswdLine('字段不足:x:1:1::')).toBeNull()
    expect(parsePasswdLine('非数字:x:uid:1::/:/bin/bash')).toBeNull()
  })

  it('可见范围：uid 1000-60000 才可管理，root、系统账号与 nobody 都不在', () => {
    const records = parseGetentPasswd(PASSWD_SAMPLE)
    const visible = records.filter((record) => isManagedUid(record.uid))
    expect(visible.map((record) => record.name)).toEqual(['ubuntu', 'elysian'])
    expect(isManagedUid(0)).toBe(false)
    expect(isManagedUid(999)).toBe(false)
    expect(isManagedUid(60000)).toBe(true)
    expect(isManagedUid(60001)).toBe(false)
    expect(isManagedUid(65534)).toBe(false)
  })
})

describe('shadow 解析与状态推导', () => {
  it('解析哈希与过期字段；空与负值视为未设置', () => {
    const records = parseGetentShadow(`${SHADOW_SAMPLE}\nedge:x:::\n`)
    expect(records[1]).toEqual({ name: 'ubuntu', passwordHash: '$6$ubuntuhash…', expireDays: null })
    // 9 字段形态（含 flag 尾字段）同样解析。
    expect(parseShadowLine('u:x:$6$h:20000:0:99999:7:::')?.expireDays).toBeNull()
    expect(parseShadowLine('u:x:$6$h:20000:0:99999:7:20765:')?.expireDays).toBe(20765)
    expect(parseShadowLine('u:x:$6$h:20000:0:99999:7:-1:')?.expireDays).toBeNull()
    expect(parseShadowLine('字段不足')).toBeNull()
    // 边界行（getent shadow 对不存在账号输出空串）解析为空数组。
    expect(parseGetentShadow('')).toEqual([])
  })

  it('sp_expire 已设且不晚于今天即 disabled；未设置或在未来为 active', () => {
    const today = daysSinceEpochUtc(NOW)
    expect(statusOf(null, NOW)).toBe('active')
    expect(statusOf(today, NOW)).toBe('disabled')
    expect(statusOf(today - 1, NOW)).toBe('disabled')
    expect(statusOf(today + 1, NOW)).toBe('active')
    // usermod -e 1 把过期日设为 1970-01-02，永远处于已过期。
    expect(statusOf(1, NOW)).toBe('disabled')
  })

  it('密码可用性：空、裸 !、* 与 ! 前缀锁定都不可用，哈希可用', () => {
    expect(passwordUsable('')).toBe(false)
    expect(passwordUsable('!')).toBe(false)
    expect(passwordUsable('*')).toBe(false)
    expect(passwordUsable('!$6$locked…')).toBe(false)
    expect(passwordUsable('$6$rounds…hash')).toBe(true)
    expect(passwordUsable('$y$j9T$hash')).toBe(true)
  })
})

describe('sudo 组与登录方式推导', () => {
  it('组成员按第四字段逗号切分', () => {
    expect([...parseGroupMembers(SUDO_GROUP_SAMPLE)].sort()).toEqual(['elysian', 'ubuntu'])
    expect(parseGroupMembers('sudo:x:27:\n').size).toBe(0)
    expect(parseGroupMembers('').size).toBe(0)
  })

  it('登录方式四档推导', () => {
    // 密码：哈希可用、无密钥。
    expect(loginMethodOf({ shell: '/bin/bash', passwordHash: '$6$h', authorizedKeysText: null })).toBe('password')
    // 密钥：哈希不可用、authorized_keys 有有效行。
    expect(
      loginMethodOf({
        shell: '/bin/bash',
        passwordHash: '!',
        authorizedKeysText: 'ssh-ed25519 AAAA占位 elysian-部署机\n',
      }),
    ).toBe('key')
    // 密码或密钥：两者皆可用。
    expect(
      loginMethodOf({
        shell: '/bin/bash',
        passwordHash: '$6$h',
        authorizedKeysText: '# 只有注释不算\nssh-ed25519 AAAA占位备注\n',
      }),
    ).toBe('password-or-key')
    // 禁止登录：shell 为 nologin（/sbin/nologin 与 /usr/sbin/nologin 同判）。
    expect(loginMethodOf({ shell: '/sbin/nologin', passwordHash: '$6$h', authorizedKeysText: 'ssh-ed25519 AAAA x\n' })).toBe('none')
    expect(loginMethodOf({ shell: '/usr/sbin/nologin', passwordHash: '$6$h', authorizedKeysText: null })).toBe('none')
    // 两者皆无：如实呈现 none，实际没有任何可用方式。
    expect(loginMethodOf({ shell: '/bin/bash', passwordHash: '*', authorizedKeysText: null })).toBe('none')
    expect(loginMethodOf({ shell: '/bin/bash', passwordHash: null, authorizedKeysText: null })).toBe('none')
  })

  it('authorized_keys 的可用性：空文件、纯注释不算密钥路径', () => {
    expect(keyUsable(null)).toBe(false)
    expect(keyUsable('')).toBe(false)
    expect(keyUsable('\n\n  \n')).toBe(false)
    expect(keyUsable('# 注释行\n')).toBe(false)
    expect(keyUsable('ssh-ed25519 AAAA占位 elysian-x\n')).toBe(true)
  })
})

describe('GECOS 备注解析与整行推导', () => {
  it('备注取 GECOS 全文 trim，空为 null', () => {
    expect(noteOfGecos('发布流程自动化使用')).toBe('发布流程自动化使用')
    expect(noteOfGecos('  带空白  ')).toBe('带空白')
    expect(noteOfGecos('')).toBeNull()
    expect(noteOfGecos('   ')).toBeNull()
  })

  it('deriveHostUser：id 即用户名、isAdmin 看组成员、createdAt 恒 null', () => {
    const passwd = parseGetentPasswd(PASSWD_SAMPLE)
    const shadow = new Map(parseGetentShadow(SHADOW_SAMPLE).map((record) => [record.name, record]))
    const sudo = parseGroupMembers(SUDO_GROUP_SAMPLE)

    const ubuntu = deriveHostUser({
      passwd: passwd.find((record) => record.name === 'ubuntu')!,
      shadow: shadow.get('ubuntu') ?? null,
      sudoMembers: sudo,
      authorizedKeysText: null,
      nowIso: NOW,
    })
    expect(ubuntu).toEqual({
      id: 'ubuntu',
      name: 'ubuntu',
      isAdmin: true,
      loginMethod: 'password',
      status: 'active',
      note: 'Ubuntu User',
      createdAt: null,
    })

    const elysian = deriveHostUser({
      passwd: passwd.find((record) => record.name === 'elysian')!,
      shadow: shadow.get('elysian') ?? null,
      sudoMembers: sudo,
      authorizedKeysText: 'ssh-ed25519 AAAA面板 elysian-root\n',
      nowIso: NOW,
    })
    // 密码锁定（!）但有密钥：登录方式如实为 key。
    expect(elysian.loginMethod).toBe('key')
    expect(elysian.isAdmin).toBe(true)
    expect(elysian.note).toBe('Elysian 面板账号')
    expect(elysian.createdAt).toBeNull()
  })

  it('过期的 elysian 账号推导为 disabled：账号过期挡一切登录', () => {
    const passwd = parseGetentPasswd(PASSWD_SAMPLE).find((record) => record.name === 'elysian')!
    const expired = deriveHostUser({
      passwd,
      shadow: { name: 'elysian', passwordHash: '$6$h', expireDays: daysSinceEpochUtc(NOW) - 1 },
      sudoMembers: new Set(),
      authorizedKeysText: 'ssh-ed25519 AAAA x\n',
      nowIso: NOW,
    })
    expect(expired.status).toBe('disabled')
    // 状态与登录方式是两个层面：过期挡登录，但登录方式仍如实推导。
    expect(expired.loginMethod).toBe('password-or-key')
  })
})
