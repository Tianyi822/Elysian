import { beforeEach, describe, expect, it } from 'vitest'
import { createSshService, type SshHostDeps } from './sshService'

/*
 * SSH 服务编排的行为测试：全部系统访问走有状态 fake（内存文件与命令账本），
 * 不执行任何真实命令。时间用注入的基准时间，断言确定。
 */

const PATHS = {
  sshdConfig: '/virtual/etc/ssh/sshd_config',
  sshdLog: '/virtual/var/log/sshd.log',
  sshdPidFile: '/virtual/run/sshd.pid',
  keygenWorkspace: '/virtual/tmp/elysian-ssh-keygen',
}

/** 本地时构造基准时间：登录统计的窗口断言与机器时区无关。 */
const NOW = new Date(2026, 8, 18, 12, 0, 0).toISOString()

const DEFAULT_PASSWD = [
  'root:x:0:0:root:/root:/bin/bash',
  'ops:x:1000:1000:Ops,,:/home/ops:/bin/bash',
  'svc:x:999:999::/home/svc:/usr/sbin/nologin',
  'nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin',
].join('\n')

const BASE_CONFIG = ['# 面板接管的 sshd_config', 'Port 22', 'PasswordAuthentication no', 'X11Forwarding yes'].join('\n')

/** 确定性摘要：fake 指纹与 fake 公钥正文都由它派生。 */
function fakeDigest(source: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${hash.toString(16)}${hash.toString(16)}`
}

type FakeHost = {
  deps: SshHostDeps
  files: Map<string, string>
  modes: Map<string, number>
  removed: string[]
  renamed: { from: string; to: string }[]
  writes: { path: string; content: string }[]
  commands: { command: string; args: readonly string[] }[]
  chpasswdInputs: string[]
  failSshdTest: () => void
}

function createFakeHost(options: { sshdConfig?: string; sshdLog?: string; passwd?: string; pidFile?: boolean } = {}): FakeHost {
  const files = new Map<string, string>()
  const modes = new Map<string, number>()
  const removed: string[] = []
  const renamed: { from: string; to: string }[] = []
  const writes: { path: string; content: string }[] = []
  const commands: { command: string; args: readonly string[] }[] = []
  const chpasswdInputs: string[] = []
  let sshdTestFails = false
  const passwd = options.passwd ?? DEFAULT_PASSWD

  if (options.sshdConfig !== undefined) files.set(PATHS.sshdConfig, options.sshdConfig)
  if (options.sshdLog !== undefined) files.set(PATHS.sshdLog, options.sshdLog)
  if (options.pidFile) files.set(PATHS.sshdPidFile, '123\n')

  function fingerprintLineOf(keyLine: string): string {
    const fields = keyLine.trim().split(/\s+/)
    const comment = fields.length >= 3 ? fields.slice(2).join(' ') : ''
    return `256 SHA256:${fakeDigest(keyLine)} ${comment} (ED25519)`
  }

  const deps: SshHostDeps = {
    async runSshKeygen(args) {
      commands.push({ command: 'ssh-keygen', args })
      if (args[0] === '-t' && args[1] === 'ed25519') {
        const comment = args[3] ?? ''
        const keyPath = args[args.length - 1] ?? ''
        files.set(keyPath, `-----BEGIN OPENSSH PRIVATE KEY-----\n${fakeDigest(`${comment}私钥`)}\n-----END OPENSSH PRIVATE KEY-----\n`)
        files.set(`${keyPath}.pub`, `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5${fakeDigest(comment)} ${comment}\n`)
        return ''
      }
      if (args[0] === '-lf') {
        const line = (files.get(args[1] ?? '') ?? '')
          .split('\n')
          .map((text) => text.trim())
          .filter(Boolean)[0]
        if (!line || !/^ssh-\S+\s+\S+/.test(line)) throw new Error('ssh-keygen: 不是有效的公钥')
        return `${fingerprintLineOf(line)}\n`
      }
      throw new Error(`ssh-keygen: 不支持的子命令 ${args.join(' ')}`)
    },
    async runSshd(args) {
      commands.push({ command: 'sshd', args })
      if (sshdTestFails) throw new Error('/etc/ssh/sshd_config 行 1: Bad 配置取值')
      return ''
    },
    async runService(action) {
      commands.push({ command: 'service', args: ['ssh', action] })
      return ''
    },
    async runChpasswd(input) {
      chpasswdInputs.push(input)
      return ''
    },
    async runGetent(args) {
      commands.push({ command: 'getent', args })
      const key = args[0] ?? ''
      if (key === 'passwd') return `${passwd}\n`
      const line = passwd.split('\n').find((candidate) => candidate.startsWith(`${key}:`))
      return line ? `${line}\n` : ''
    },
    async readText(path) {
      const content = files.get(path)
      if (content === undefined) throw new Error(`ENOENT: ${path}`)
      return content
    },
    async writeText(path, content) {
      files.set(path, content)
      writes.push({ path, content })
    },
    async exists(path) {
      return files.has(path)
    },
    async rename(from, to) {
      const content = files.get(from)
      if (content === undefined) throw new Error(`ENOENT: ${from}`)
      files.delete(from)
      files.set(to, content)
      renamed.push({ from, to })
    },
    async chmod(path, mode) {
      modes.set(path, mode)
    },
    async mkdir() {
      // fake 不区分目录与文件：exists 由 files 决定，目录创建只记账。
    },
    async remove(path) {
      files.delete(path)
      removed.push(path)
    },
    nowIso: () => NOW,
    paths: PATHS,
  }

  return { deps, files, modes, removed, renamed, writes, commands, chpasswdInputs, failSshdTest: () => { sshdTestFails = true } }
}

const OPS_AUTHORIZED_KEYS = '/home/ops/.ssh/authorized_keys'

beforeEach(() => {
  // fake 每个用例自建，这里只保证用例不共享状态。
})

describe('createSshService 配置读写', () => {
  it('settings 解析配置，缺省指令按 sshd 默认值兜底', async () => {
    const host = createFakeHost({ sshdConfig: 'Port 73\nPasswordAuthentication no\n' })
    const service = createSshService(host.deps)
    expect(await service.settings()).toEqual({ passwordAuthEnabled: false, keyAuthEnabled: true, port: 73 })
  })

  it('setPort：补丁、备份、原子写、sshd -t 预检、在跑时重启', async () => {
    const host = createFakeHost({ sshdConfig: BASE_CONFIG, pidFile: true })
    const service = createSshService(host.deps)

    const settings = await service.setPort(2202)
    expect(settings.port).toBe(2202)
    // 只替换目标行：其余行逐字保留（原文件本无结尾换行，补丁不引入）。
    expect(host.files.get(PATHS.sshdConfig)).toBe(BASE_CONFIG.replace('Port 22', 'Port 2202'))
    // 写前备份保留原全文。
    expect(host.files.get(`${PATHS.sshdConfig}.bak`)).toBe(BASE_CONFIG)
    // 原子写：临时文件 rename 顶替，而不是原地覆写。
    expect(host.renamed).toContainEqual({ from: `${PATHS.sshdConfig}.elysian-tmp`, to: PATHS.sshdConfig })
    // 预检与重启都被调用。
    expect(host.commands).toContainEqual({ command: 'sshd', args: ['-t', '-f', PATHS.sshdConfig] })
    expect(host.commands).toContainEqual({ command: 'service', args: ['ssh', 'restart'] })
  })

  it('sshd -t 预检失败：回滚原配置并报中文错误，不重启', async () => {
    const host = createFakeHost({ sshdConfig: BASE_CONFIG, pidFile: true })
    host.failSshdTest()
    const service = createSshService(host.deps)

    await expect(service.setPort(2202)).rejects.toThrow('已回滚原配置')
    expect(host.files.get(PATHS.sshdConfig)).toBe(BASE_CONFIG)
    expect(host.files.get(`${PATHS.sshdConfig}.bak`)).toBe(BASE_CONFIG)
    expect(host.commands).not.toContainEqual({ command: 'service', args: ['ssh', 'restart'] })
  })

  it('服务未在跑时只写配置不重启', async () => {
    const host = createFakeHost({ sshdConfig: BASE_CONFIG })
    const service = createSshService(host.deps)
    await service.setPort(2202)
    expect(host.commands).toContainEqual({ command: 'sshd', args: ['-t', '-f', PATHS.sshdConfig] })
    expect(host.commands.filter((entry) => entry.command === 'service')).toEqual([])
  })

  it('setAuthMethods 同时补丁两条认证指令', async () => {
    const host = createFakeHost({ sshdConfig: BASE_CONFIG })
    const service = createSshService(host.deps)
    const settings = await service.setAuthMethods({ passwordAuthEnabled: true, keyAuthEnabled: false })
    expect(settings).toEqual({ passwordAuthEnabled: true, keyAuthEnabled: false, port: 22 })
    const text = host.files.get(PATHS.sshdConfig) ?? ''
    expect(text).toContain('PasswordAuthentication yes')
    expect(text).toContain('PubkeyAuthentication no')
  })

  it('非法端口被拒绝且不产生任何写入', async () => {
    const host = createFakeHost({ sshdConfig: BASE_CONFIG })
    const service = createSshService(host.deps)
    await expect(service.setPort(0)).rejects.toThrow('SSH 端口需为 1-65535 的整数')
    await expect(service.setPort(65536)).rejects.toThrow()
    await expect(service.setPort(22.5)).rejects.toThrow()
    expect(host.writes).toEqual([])
  })

  it('saveRootLoginPolicy 落盘并回读；取值限契约枚举', async () => {
    const host = createFakeHost({ sshdConfig: BASE_CONFIG })
    const service = createSshService(host.deps)
    const auth = await service.saveRootLoginPolicy('no')
    expect(auth.policy).toBe('no')
    expect(host.files.get(PATHS.sshdConfig)).toContain('PermitRootLogin no')
    await expect(service.saveRootLoginPolicy('随便' as never)).rejects.toThrow('无效的 Root 登录策略')
  })
})

describe('createSshService 服务与登录统计', () => {
  /** 日志按时间顺序书写（旧在前），真实日志文件就是这个顺序。 */
  const LOG = [
    `Sep 01 08:00:00 elysian sshd[4]: Accepted password for ops from 1.2.3.4 port 444 ssh2`,
    `Sep 17 23:00:00 elysian sshd[3]: Failed password for ops from 5.6.7.8 port 333 ssh2`,
    `Sep 18 10:00:00 elysian sshd[1]: Accepted publickey for root from 1.2.3.4 port 111 ssh2`,
    `Sep 18 11:00:00 elysian sshd[2]: Failed password for root from 5.6.7.8 port 222 ssh2`,
  ].join('\n')

  it('overview：pidfile 决定 enabled/status，changedAt 恒 null，统计三窗口', async () => {
    const host = createFakeHost({ sshdLog: LOG, pidFile: true })
    const service = createSshService(host.deps)
    expect(await service.overview()).toEqual({
      enabled: true,
      status: 'running',
      changedAt: null,
      stats: {
        today: { succeeded: 1, failed: 1 },
        yesterday: { succeeded: 0, failed: 1 },
        last7Days: { succeeded: 1, failed: 2 },
      },
    })
  })

  it('overview：pidfile 不在则视为停用；日志缺失时统计为零', async () => {
    const service = createSshService(createFakeHost().deps)
    const overview = await service.overview()
    expect(overview.status).toBe('stopped')
    expect(overview.enabled).toBe(false)
    expect(overview.stats).toEqual({
      today: { succeeded: 0, failed: 0 },
      yesterday: { succeeded: 0, failed: 0 },
      last7Days: { succeeded: 0, failed: 0 },
    })
  })

  it('setServiceEnabled 执行 service ssh start|stop', async () => {
    const host = createFakeHost()
    const service = createSshService(host.deps)
    await service.setServiceEnabled(true)
    await service.setServiceEnabled(false)
    expect(host.commands.filter((entry) => entry.command === 'service')).toEqual([
      { command: 'service', args: ['ssh', 'start'] },
      { command: 'service', args: ['ssh', 'stop'] },
    ])
  })

  it('listLoginRecords 按时间倒序返回', async () => {
    const service = createSshService(createFakeHost({ sshdLog: LOG }).deps)
    const records = await service.listLoginRecords()
    expect(records.map((record) => record.user)).toEqual(['root', 'root', 'ops', 'ops'])
    const times = records.map((record) => Date.parse(record.at))
    expect([...times].sort((a, b) => b - a)).toEqual(times)
  })
})

describe('createSshService Root 凭据', () => {
  it('resetRootPassword：弱密码拒绝且不触达 chpasswd；强密码走 stdin', async () => {
    const host = createFakeHost({ sshdConfig: BASE_CONFIG })
    const service = createSshService(host.deps)

    await expect(service.resetRootPassword('abcdefgh')).rejects.toThrow('密码强度不足')
    expect(host.chpasswdInputs).toEqual([])

    const result = await service.resetRootPassword('Elysian#2026Root')
    expect(result.strength).toBe('strong')
    expect(host.chpasswdInputs).toEqual(['root:Elysian#2026Root'])
    // 密码绝不进命令行：全部 execFile 参数都不含密码明文。
    for (const entry of host.commands) {
      expect(entry.args.join(' ')).not.toContain('Elysian#2026Root')
    }
    expect((await service.rootAuth()).passwordResetAt).toBe(NOW)
  })

  it('rootAuth：authorized_keys 为空时 key 为 null（尚未生成）', async () => {
    const service = createSshService(createFakeHost({ sshdConfig: 'PermitRootLogin prohibit-password\n' }).deps)
    const auth = await service.rootAuth()
    expect(auth.policy).toBe('prohibit-password')
    expect(auth.key).toBeNull()
    expect(auth.passwordResetAt).toBeNull()
  })

  it('rootAuth：有公钥时给出材料且不带私钥', async () => {
    const host = createFakeHost({ sshdConfig: 'PermitRootLogin prohibit-password\n' })
    host.files.set('/root/.ssh/authorized_keys', 'ssh-ed25519 AAAAroot占位 root@legacy\n')
    const service = createSshService(host.deps)
    const auth = await service.rootAuth()
    expect(auth.key).toMatchObject({
      algorithm: 'ssh-ed25519 256',
      fingerprint: expect.stringMatching(/^SHA256:/),
      publicKey: 'ssh-ed25519 AAAAroot占位 root@legacy',
    })
    expect(auth.key?.privateKey).toBeUndefined()
  })

  it('createRootKey：新公钥替换 root 授权文件首行、外来行保留，私钥一次性返回且不落盘', async () => {
    const host = createFakeHost({ sshdConfig: BASE_CONFIG })
    host.files.set('/root/.ssh/authorized_keys', 'ssh-ed25519 AAAAroot旧 root@legacy\nssh-ed25519 AAAA外来 foreign@example\n')
    const service = createSshService(host.deps)

    const generated = await service.createRootKey()
    expect(generated.policy).toBe('prohibit-password')
    expect(generated.key).toMatchObject({ algorithm: 'ssh-ed25519 256' })
    expect(generated.key?.fingerprint).toMatch(/^SHA256:/)
    expect(generated.key?.privateKey).toContain('-----BEGIN OPENSSH PRIVATE KEY-----')
    expect(generated.key?.publicKey).toContain('elysian-root')

    // 首行被新公钥替换，外来公钥行原样保留；权限收紧与登录密钥同规。
    const text = host.files.get('/root/.ssh/authorized_keys') ?? ''
    expect(text).toBe(`${generated.key?.publicKey}\nssh-ed25519 AAAA外来 foreign@example\n`)
    expect(host.modes.get('/root/.ssh')).toBe(0o700)
    expect(host.modes.get('/root/.ssh/authorized_keys')).toBe(0o600)

    // 私钥不持久化：账本里没有任何写盘内容含私钥；临时密钥文件已删。
    for (const write of host.writes) {
      expect(write.content).not.toContain('PRIVATE KEY')
    }
    const removedPrivate = host.removed.filter((path) => !path.includes('verify-'))
    expect(removedPrivate).toHaveLength(2)

    // 之后的 rootAuth 只剩公钥与指纹；rootAuth 的首行即新公钥。
    const after = await service.rootAuth()
    expect(after.key?.publicKey).toBe(generated.key?.publicKey)
    expect(after.key?.privateKey).toBeUndefined()
  })

  it('createRootKey：authorized_keys 不存在时创建只含新公钥的文件', async () => {
    const host = createFakeHost({ sshdConfig: BASE_CONFIG })
    const service = createSshService(host.deps)

    const generated = await service.createRootKey()
    expect(host.files.get('/root/.ssh/authorized_keys')).toBe(`${generated.key?.publicKey}\n`)
    expect(generated.key?.privateKey).toContain('-----BEGIN OPENSSH PRIVATE KEY-----')
  })
})

describe('createSshService 密钥管理', () => {
  it('keyAccounts 只列有登录 shell 且 uid≥1000 的账号，root 不列', async () => {
    const service = createSshService(createFakeHost().deps)
    expect(await service.keyAccounts()).toEqual([{ id: 'ops', name: 'ops' }])
  })

  it('createKey：生成 ed25519、公钥落 authorized_keys、权限收紧、私钥一次性返回且不落盘', async () => {
    const host = createFakeHost({ sshdConfig: BASE_CONFIG })
    const service = createSshService(host.deps)

    const created = await service.createKey({ name: '部署机', userId: 'ops' })
    expect(created).toMatchObject({ name: '部署机', userId: 'ops', algorithm: 'ssh-ed25519 256' })
    expect(created.fingerprint).toMatch(/^SHA256:/)
    expect(created.privateKey).toContain('-----BEGIN OPENSSH PRIVATE KEY-----')

    // ssh-keygen 数组传参，注释为 elysian-<名称>，空口令。
    expect(host.commands).toContainEqual({
      command: 'ssh-keygen',
      args: ['-t', 'ed25519', '-C', 'elysian-部署机', '-N', '', '-f', expect.stringContaining('/elysian-key-')],
    })

    // 公钥行落进 ops 的 authorized_keys，注释带面板前缀。
    const text = host.files.get(OPS_AUTHORIZED_KEYS) ?? ''
    expect(text).toContain(created.publicKey)
    expect(created.publicKey).toContain('elysian-部署机')

    // 权限收紧：.ssh 0700、authorized_keys 0600。
    expect(host.modes.get('/home/ops/.ssh')).toBe(0o700)
    expect(host.modes.get(OPS_AUTHORIZED_KEYS)).toBe(0o600)

    // 私钥不持久化：账本里没有任何写盘内容含私钥；临时密钥文件已删。
    for (const write of host.writes) {
      expect(write.content).not.toContain('PRIVATE KEY')
    }
    const removedPrivate = host.removed.filter((path) => !path.includes('verify-'))
    expect(removedPrivate).toHaveLength(2)
    expect(host.files.get(OPS_AUTHORIZED_KEYS)).toBeDefined()

    // 列表能看到新密钥，且不返回私钥。
    const keys = await service.listKeys()
    expect(keys.map((key) => key.name)).toContain('部署机')
    expect(keys.every((key) => key.privateKey === undefined)).toBe(true)
  })

  it('createKey 拒绝换行与控制字符的名称（命令注入防线）', async () => {
    const host = createFakeHost({ sshdConfig: BASE_CONFIG })
    const service = createSshService(host.deps)
    await expect(service.createKey({ name: '部署机\nPort 2222', userId: 'ops' })).rejects.toThrow(
      '密钥名称不能包含换行或控制字符',
    )
    await expect(service.createKey({ name: '部署机\u0000', userId: 'ops' })).rejects.toThrow(
      '密钥名称不能包含换行或控制字符',
    )
    await expect(service.createKey({ name: '   ', userId: 'ops' })).rejects.toThrow('密钥名称需为 1-32 个字符')
    expect(host.commands.filter((entry) => entry.command === 'ssh-keygen')).toEqual([])
  })

  it('createKey 的归属账号必须是白名单里的真实账号，路径不可注入', async () => {
    const host = createFakeHost({ sshdConfig: BASE_CONFIG })
    const service = createSshService(host.deps)
    await expect(service.createKey({ name: '越权', userId: 'root' })).rejects.toThrow('归属账号不存在：root')
    await expect(service.createKey({ name: '越权', userId: '../../etc' })).rejects.toThrow('归属账号不存在：../../etc')
    await expect(service.createKey({ name: '越权', userId: 'svc' })).rejects.toThrow('归属账号不存在：svc')
    expect(host.commands.filter((entry) => entry.command === 'ssh-keygen')).toEqual([])
    expect(host.writes.map((write) => write.path)).not.toContain('/etc/.ssh/authorized_keys')
  })

  it('createKey 名称重复拒绝', async () => {
    const host = createFakeHost({ sshdConfig: BASE_CONFIG })
    const service = createSshService(host.deps)
    await service.createKey({ name: '部署机', userId: 'ops' })
    await expect(service.createKey({ name: '部署机', userId: 'ops' })).rejects.toThrow('密钥名称已存在：部署机')
  })

  it('removeKey 级联到 authorized_keys：行被移除、写前备份；未知 id 报中文错', async () => {
    const host = createFakeHost({ sshdConfig: BASE_CONFIG })
    const service = createSshService(host.deps)
    const created = await service.createKey({ name: '部署机', userId: 'ops' })
    const afterCreate = host.files.get(OPS_AUTHORIZED_KEYS) ?? ''

    await service.removeKey(created.id)
    // 级联：账号的授权文件里那行公钥消失，文件回到创建前（空）。
    expect((host.files.get(OPS_AUTHORIZED_KEYS) ?? '').trim()).toBe('')
    expect(host.files.get(`${OPS_AUTHORIZED_KEYS}.bak`)).toBe(afterCreate)
    expect((await service.listKeys()).map((key) => key.id)).not.toContain(created.id)

    await expect(service.removeKey('sshkey-不存在')).rejects.toThrow('未找到登录密钥 sshkey-不存在')
  })

  it('外来公钥按注释呈现名称，也能按 id 删除', async () => {
    const foreign = 'ssh-ed25519 AAAA外来占位 old-laptop'
    const host = createFakeHost({ sshdConfig: BASE_CONFIG })
    host.files.set(OPS_AUTHORIZED_KEYS, `${foreign}\n`)
    const service = createSshService(host.deps)

    const keys = await service.listKeys()
    expect(keys[0]).toMatchObject({ name: 'old-laptop', userId: 'ops', publicKey: foreign })
    await service.removeKey(keys[0]!.id)
    expect((host.files.get(OPS_AUTHORIZED_KEYS) ?? '').trim()).toBe('')
  })
})
