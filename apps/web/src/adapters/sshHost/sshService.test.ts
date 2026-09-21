import { beforeEach, describe, expect, it } from 'vitest'
import { SSH_LOG_TAIL_BYTES, createSshService, type SshHostDeps } from './sshService'

/*
 * SSH 服务编排的行为测试：全部系统访问走有状态 fake（内存文件与命令账本），
 * 不执行任何真实命令。时间用注入的基准时间，断言确定。
 */

const PATHS = {
  sshdConfig: '/virtual/etc/ssh/sshd_config',
  sshdLog: '/virtual/var/log/sshd.log',
  sshdPidFile: '/virtual/run/sshd.pid',
  keygenWorkspace: '/virtual/tmp/elysian-ssh-keygen',
  changedAtStamp: '/virtual/var/lib/elysian/ssh-changed-at',
}

/** fake pidfile 里的主进程号：/proc/<pid>/comm 的身份核实以此定位。 */
const SSHD_PID = 123
const SSHD_PROC_COMM = `/proc/${SSHD_PID}/comm`

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
  owners: Map<string, { uid: number; gid: number }>
  /** sshd 生命周期原语账本：start / stop / reload。 */
  serviceSignals: string[]
  removed: string[]
  renamed: { from: string; to: string }[]
  writes: { path: string; content: string }[]
  reads: string[]
  tailReads: { path: string; maxBytes: number }[]
  commands: { command: string; args: readonly string[] }[]
  chpasswdInputs: string[]
  failSshdTest: (value?: boolean) => void
}

function createFakeHost(
  options: {
    sshdConfig?: string
    sshdLog?: string
    passwd?: string
    pidFile?: boolean
    /** pidfile 在但 /proc/<pid>/comm 的内容：模拟 pid 被无关进程复用（默认 'sshd\n'）。 */
    pidFileComm?: string
    /** 启停后 pidfile 何时收敛：立即（默认）｜下一次 delay 调用时（模拟 TERM 后异步退出）｜永不（超时路径）。 */
    pidFileSettle?: 'on-signal' | 'after-delay' | 'never'
    /** SIGHUP 重载后 sshd 是否退出（模拟端口被占用等只在真实监听时暴露的致命问题）。 */
    reloadKillsSshd?: boolean
  } = {},
): FakeHost {
  const files = new Map<string, string>()
  const modes = new Map<string, number>()
  const owners = new Map<string, { uid: number; gid: number }>()
  const serviceSignals: string[] = []
  const removed: string[] = []
  const renamed: { from: string; to: string }[] = []
  const writes: { path: string; content: string }[] = []
  const reads: string[] = []
  const tailReads: { path: string; maxBytes: number }[] = []
  const commands: { command: string; args: readonly string[] }[] = []
  const chpasswdInputs: string[] = []
  let sshdTestFails = false
  const passwd = options.passwd ?? DEFAULT_PASSWD
  const pidFileSettle = options.pidFileSettle ?? 'on-signal'
  /** after-delay 模式下挂起的收敛动作：真实 sshd 收到 TERM 后异步退出、pidfile 晚一拍才消失。 */
  let pendingSettle: 'add' | 'remove' | null = null

  if (options.sshdConfig !== undefined) files.set(PATHS.sshdConfig, options.sshdConfig)
  if (options.sshdLog !== undefined) files.set(PATHS.sshdLog, options.sshdLog)
  if (options.pidFile) {
    files.set(PATHS.sshdPidFile, `${SSHD_PID}\n`)
    // 对齐真实容器形态：pidfile 在即有 /proc/<pid>/comm 可读，默认身份是 sshd。
    files.set(SSHD_PROC_COMM, options.pidFileComm ?? 'sshd\n')
  }

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
    async startSshd() {
      if (pidFileSettle === 'after-delay') pendingSettle = 'add'
      else if (pidFileSettle === 'on-signal') {
        files.set(PATHS.sshdPidFile, `${SSHD_PID}\n`)
        files.set(SSHD_PROC_COMM, 'sshd\n')
      }
      serviceSignals.push('start')
    },
    async stopSshd() {
      if (pidFileSettle === 'after-delay') pendingSettle = 'remove'
      else if (pidFileSettle === 'on-signal') {
        files.delete(PATHS.sshdPidFile)
        files.delete(SSHD_PROC_COMM)
      }
      serviceSignals.push('stop')
    },
    async delay() {
      if (pendingSettle === 'add') {
        files.set(PATHS.sshdPidFile, `${SSHD_PID}\n`)
        files.set(SSHD_PROC_COMM, 'sshd\n')
      }
      if (pendingSettle === 'remove') {
        files.delete(PATHS.sshdPidFile)
        files.delete(SSHD_PROC_COMM)
      }
      pendingSettle = null
    },
    async reloadSshd() {
      if (!files.has(PATHS.sshdPidFile)) return
      serviceSignals.push('reload')
      if (options.reloadKillsSshd) {
        // 对齐真实语义：SIGHUP 触发 re-exec，绑定失败（如端口被占用）在重启后才暴露，
        // pidfile 晚一拍才消失——存活复查必须轮询而不是只看一眼。
        pendingSettle = 'remove'
      }
    },
    async runChpasswd(input) {
      chpasswdInputs.push(input)
      return ''
    },
    async runGetent(args) {
      commands.push({ command: 'getent', args })
      // 对齐真 getent 语义：首参是数据库名而非账号名——`getent root` 在真实环境报 Unknown database。
      const [database, name] = args
      if (database !== 'passwd') throw new Error(`Unknown database: ${database ?? ''}`)
      if (name === undefined) return `${passwd}\n`
      const line = passwd.split('\n').find((candidate) => candidate.startsWith(`${name}:`))
      return line ? `${line}\n` : ''
    },
    async readText(path) {
      const content = files.get(path)
      if (content === undefined) throw new Error(`ENOENT: ${path}`)
      reads.push(path)
      return content
    },
    async readTextTail(path, maxBytes) {
      // 对齐真实实现语义：按字节取尾，发生截断时丢弃不完整的首行。
      const content = files.get(path)
      if (content === undefined) throw new Error(`ENOENT: ${path}`)
      tailReads.push({ path, maxBytes })
      const bytes = Buffer.from(content, 'utf8')
      if (bytes.length <= maxBytes) return content
      const text = bytes.subarray(bytes.length - maxBytes).toString('utf8')
      const firstNewline = text.indexOf('\n')
      return firstNewline < 0 ? '' : text.slice(firstNewline + 1)
    },
    async readDir(path) {
      // fake 不区分目录与文件：列出路径下的直接子项名，目录本身不存在即空。
      const prefix = path.endsWith('/') ? path : `${path}/`
      const names = new Set<string>()
      for (const key of files.keys()) {
        if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split('/')[0] ?? '')
      }
      return [...names]
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
    async chown(path, uid, gid) {
      owners.set(path, { uid, gid })
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

  return {
    deps,
    files,
    modes,
    owners,
    serviceSignals,
    removed,
    renamed,
    writes,
    reads,
    tailReads,
    commands,
    chpasswdInputs,
    failSshdTest: (value = true) => {
      sshdTestFails = value
    },
  }
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

  it('setPort：补丁、备份、原子写、sshd -t 预检、在跑时 SIGHUP 重载（不走 service restart）', async () => {
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
    // 预检与重载都被调用；重载是 SIGHUP 信号，不是 service 命令。
    expect(host.commands).toContainEqual({ command: 'sshd', args: ['-t', '-f', PATHS.sshdConfig] })
    expect(host.serviceSignals).toEqual(['reload'])
    expect(host.commands.filter((entry) => entry.command === 'service')).toEqual([])
  })

  it('sshd -t 预检失败：回滚原配置并报中文错误，不重载', async () => {
    const host = createFakeHost({ sshdConfig: BASE_CONFIG, pidFile: true })
    host.failSshdTest()
    const service = createSshService(host.deps)

    await expect(service.setPort(2202)).rejects.toThrow('已回滚原配置')
    expect(host.files.get(PATHS.sshdConfig)).toBe(BASE_CONFIG)
    expect(host.files.get(`${PATHS.sshdConfig}.bak`)).toBe(BASE_CONFIG)
    expect(host.serviceSignals).toEqual([])
    // 回滚同样走原子写（f31）：tmp + rename 顶替，不走原地覆写；补丁与回滚各一次。
    expect(host.renamed.filter((entry) => entry.to === PATHS.sshdConfig)).toHaveLength(2)
  })

  it('重载后复查存活：SIGHUP 后 sshd 退出（如端口被占用）则回滚原文并报中文错误', async () => {
    const host = createFakeHost({ sshdConfig: BASE_CONFIG, pidFile: true, reloadKillsSshd: true })
    const service = createSshService(host.deps)

    const failure = await service.setPort(2202).then(
      () => null,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(Error)
    const message = (failure as Error).message
    // 错误说明改了什么、为何回滚：改动的指令与取值、回滚动作、服务现状。
    expect(message).toContain('重载后 sshd 进程退出')
    expect(message).toContain('Port=2202')
    expect(message).toContain('已回滚为原配置')
    // 原文完整回到磁盘；回滚也是原子写。
    expect(host.files.get(PATHS.sshdConfig)).toBe(BASE_CONFIG)
    expect(host.renamed.filter((entry) => entry.to === PATHS.sshdConfig)).toHaveLength(2)
    // 服务已死要如实呈现：面板开关回到停止位，而不是报成功。
    expect((await service.overview()).status).toBe('stopped')
  })

  it('重载后存活复查通过：正常路径不受轮询影响，配置与重载都完成', async () => {
    const host = createFakeHost({ sshdConfig: BASE_CONFIG, pidFile: true })
    const service = createSshService(host.deps)
    const settings = await service.setPort(2202)
    expect(settings.port).toBe(2202)
    expect(host.files.get(PATHS.sshdConfig)).toContain('Port 2202')
    expect(host.serviceSignals).toEqual(['reload'])
    expect((await service.overview()).status).toBe('running')
  })

  it('并发配置补丁排队落盘：端口与认证开关都生效，不发生后写以旧原文覆写', async () => {
    const host = createFakeHost({ sshdConfig: BASE_CONFIG })
    const service = createSshService(host.deps)

    // 两个补丁同时发起：若各自拿着旧原文计算，后写者会静默抹掉先写者的改动。
    await Promise.all([
      service.setPort(2202),
      service.setAuthMethods({ passwordAuthEnabled: true, keyAuthEnabled: false }),
    ])
    const text = host.files.get(PATHS.sshdConfig) ?? ''
    expect(text).toContain('Port 2202')
    expect(text).toContain('PasswordAuthentication yes')
    expect(text).toContain('PubkeyAuthentication no')
    expect(await service.settings()).toEqual({ port: 2202, passwordAuthEnabled: true, keyAuthEnabled: false })
  })

  it('配置写队列中的失败不阻塞后续配置变更', async () => {
    const host = createFakeHost({ sshdConfig: BASE_CONFIG })
    const service = createSshService(host.deps)

    host.failSshdTest()
    await expect(service.setPort(2202)).rejects.toThrow('已回滚原配置')
    host.failSshdTest(false)
    await expect(service.setPort(2303)).resolves.toMatchObject({ port: 2303 })
  })

  it('服务未在跑时只写配置不重载', async () => {
    const host = createFakeHost({ sshdConfig: BASE_CONFIG })
    const service = createSshService(host.deps)
    await service.setPort(2202)
    expect(host.commands).toContainEqual({ command: 'sshd', args: ['-t', '-f', PATHS.sshdConfig] })
    expect(host.serviceSignals).toEqual([])
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

  it('setPort 注释掉多余的未注释 Port 行（Port 为累积监听指令，旧端口不再监听）', async () => {
    const host = createFakeHost({ sshdConfig: 'Port 22\nPort 23\nPasswordAuthentication yes\n' })
    const service = createSshService(host.deps)
    const settings = await service.setPort(2202)
    expect(settings.port).toBe(2202)
    expect(host.files.get(PATHS.sshdConfig)).toBe('Port 2202\n#Port 23\nPasswordAuthentication yes\n')
  })
})

describe('createSshService Include 语义', () => {
  /** 主配置所在目录：相对路径的 Include 以它为基准（对齐 sshd 的 /etc/ssh 基准）。 */
  const SSH_CONFIG_DIR = '/virtual/etc/ssh'
  const DROPIN = (name: string) => `${SSH_CONFIG_DIR}/sshd_config.d/${name}`
  /** 容器里 Debian 系出厂的常见形态：Include 在前、指令多被注释。 */
  const STOCK_CONFIG = ['Include sshd_config.d/*.conf', '#Port 22', '#PasswordAuthentication yes'].join('\n')

  it('settings 展开 Include 读生效值：drop-in 取值按字典序先到先得，优先于主文件缺省', async () => {
    const host = createFakeHost({ sshdConfig: STOCK_CONFIG })
    host.files.set(DROPIN('10-hardening.conf'), 'Port 2222\nPasswordAuthentication no\n')
    host.files.set(DROPIN('20-later.conf'), 'Port 3333\n')
    const service = createSshService(host.deps)
    expect(await service.settings()).toEqual({ passwordAuthEnabled: false, keyAuthEnabled: true, port: 2222 })
  })

  it('绝对路径与无通配的 Include 同样展开；目录不存在时按零个文件处理', async () => {
    const host = createFakeHost({
      sshdConfig: `Include ${SSH_CONFIG_DIR}/main.conf\nInclude sshd_config.d/*.conf\n`,
    })
    host.files.set(`${SSH_CONFIG_DIR}/main.conf`, 'Port 2468\n')
    const service = createSshService(host.deps)
    expect((await service.settings()).port).toBe(2468)
  })

  it('Include 的等号写法同样展开：面板读到的仍是 drop-in 生效值', async () => {
    // sshd_config(5)：关键词与取值可用「可选空白 + 恰一个 = + 可选空白」分隔。
    // 漏展开时面板按主文件缺省呈现，显示值可与 sshd 实效相反。
    const host = createFakeHost({ sshdConfig: `Include=${SSH_CONFIG_DIR}/main.conf\n` })
    host.files.set(`${SSH_CONFIG_DIR}/main.conf`, 'Port 2468\nPasswordAuthentication no\n')
    const service = createSshService(host.deps)
    expect(await service.settings()).toEqual({ port: 2468, passwordAuthEnabled: false, keyAuthEnabled: true })
  })

  it('setPort 的面板行插到 Include 之前：不被 drop-in 遮蔽，回读即生效值', async () => {
    const host = createFakeHost({ sshdConfig: STOCK_CONFIG })
    host.files.set(DROPIN('10-hardening.conf'), 'Port 2222\n')
    const service = createSshService(host.deps)

    const settings = await service.setPort(2202)
    expect(settings.port).toBe(2202)
    const text = host.files.get(PATHS.sshdConfig) ?? ''
    expect(text.indexOf('Port 2202')).toBeLessThan(text.indexOf('Include'))
    // 主文件只有面板写入的一个未注释 Port 行（#Port 22 是注释，不算）。
    expect(text.split('\n').filter((line) => /^Port\s/.test(line))).toEqual(['Port 2202'])
    // 补丁只写主文件：drop-in 原样不动。
    expect(host.files.get(DROPIN('10-hardening.conf'))).toBe('Port 2222\n')
  })

  it('setAuthMethods 的面板行同样先于 Include 取得取值，压过 drop-in 的同名指令', async () => {
    const host = createFakeHost({ sshdConfig: STOCK_CONFIG })
    host.files.set(DROPIN('50-auth.conf'), 'PasswordAuthentication yes\nPubkeyAuthentication no\n')
    const service = createSshService(host.deps)
    const settings = await service.setAuthMethods({ passwordAuthEnabled: false, keyAuthEnabled: true })
    expect(settings).toEqual({ passwordAuthEnabled: false, keyAuthEnabled: true, port: 22 })
  })

  it('rootAuth 的策略读生效值；保存后的面板行接管 drop-in', async () => {
    const host = createFakeHost({ sshdConfig: STOCK_CONFIG })
    host.files.set(DROPIN('60-cloud.conf'), 'Port 2222\nPermitRootLogin yes\n')
    const service = createSshService(host.deps)
    expect((await service.rootAuth()).policy).toBe('yes')
    const after = await service.saveRootLoginPolicy('no')
    expect(after.policy).toBe('no')
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

  it('服务探测核实进程身份：pidfile 在但 /proc/<pid>/comm 不是 sshd（pid 被复用）视为未运行', async () => {
    const host = createFakeHost({ pidFile: true, pidFileComm: 'bash\n' })
    const service = createSshService(host.deps)
    const overview = await service.overview()
    expect(overview.enabled).toBe(false)
    expect(overview.status).toBe('stopped')
  })

  it('pidfile 残留但 comm 读不到（进程已退）或内容非法时同样视为未运行', async () => {
    const stale = createFakeHost({ pidFile: true })
    stale.files.delete(SSHD_PROC_COMM)
    expect((await createSshService(stale.deps).overview()).status).toBe('stopped')

    const garbage = createFakeHost({ pidFile: true })
    garbage.files.set(PATHS.sshdPidFile, 'not-a-pid\n')
    expect((await createSshService(garbage.deps).overview()).status).toBe('stopped')
  })

  it('配置补丁只在核实身份为运行中时才重载：pid 被复用时只写配置不发信号', async () => {
    const host = createFakeHost({ sshdConfig: BASE_CONFIG, pidFile: true, pidFileComm: 'bash\n' })
    const service = createSshService(host.deps)
    await service.setPort(2202)
    expect(host.files.get(PATHS.sshdConfig)).toContain('Port 2202')
    expect(host.serviceSignals).toEqual([])
  })

  it('登录日志只读尾部：超字节预算的旧段不整读进内存，截断出的不完整首行被丢弃', async () => {
    const recent = [
      'Sep 18 10:00:00 elysian sshd[1]: Accepted publickey for ops from 1.1.1.1 port 111 ssh2',
      'Sep 18 11:00:00 elysian sshd[2]: Failed password for root from 5.6.7.8 port 222 ssh2',
    ].join('\n')
    // 旧段是一整行超预算的填充：尾部读取从行中截断，不完整首行必须被丢弃，
    // 否则截断余烬可能恰好拼成一条无时间戳的假记录。
    const filler = `${'x'.repeat(SSH_LOG_TAIL_BYTES + 4096)}\n`
    const host = createFakeHost({ sshdLog: `${filler}${recent}\n` })
    const service = createSshService(host.deps)

    const records = await service.listLoginRecords()
    expect(records.map((record) => record.user)).toEqual(['root', 'ops'])
    // 只走尾部读取：整读（readText）不触达日志文件。
    expect(host.reads).not.toContain(PATHS.sshdLog)
    expect(host.tailReads).toEqual([{ path: PATHS.sshdLog, maxBytes: SSH_LOG_TAIL_BYTES }])
  })

  it('setServiceEnabled 走面板自管原语：start 带 -E 的启动与 pidfile 停止', async () => {
    const host = createFakeHost({ pidFile: true })
    const service = createSshService(host.deps)
    await service.setServiceEnabled(true)
    await service.setServiceEnabled(false)
    expect(host.serviceSignals).toEqual(['start', 'stop'])
    // 不再依赖 service 命令：它的 SSHD_OPTS 为空，restart/start 会丢 -E 日志参数。
    expect(host.commands.filter((entry) => entry.command === 'service')).toEqual([])
  })

  it('changedAt 写入宿主时间戳：未改过为 null，启停成功后新实例仍能读到', async () => {
    const host = createFakeHost({ pidFile: true })
    const service = createSshService(host.deps)
    expect((await service.overview()).changedAt).toBeNull()
    await service.setServiceEnabled(false)
    expect((await service.overview()).changedAt).toBe(NOW)
    expect(host.files.get(PATHS.changedAtStamp)).toBe(NOW)

    const reopened = createSshService(host.deps)
    expect((await reopened.overview()).changedAt).toBe(NOW)
    await reopened.setServiceEnabled(true)
    expect((await reopened.overview()).changedAt).toBe(NOW)
    expect(host.files.get(PATHS.changedAtStamp)).toBe(NOW)
  })

  it('停用等 pidfile 收敛再回包：TERM 后 sshd 异步退出也不会把开关留在打开位', async () => {
    const service = createSshService(createFakeHost({ pidFile: true, pidFileSettle: 'after-delay' }).deps)
    const overview = await service.setServiceEnabled(false)
    expect(overview.enabled).toBe(false)
    expect(overview.status).toBe('stopped')
  })

  it('启用同样等 pidfile 出现再回包，避免响应带回过期的停用态', async () => {
    const service = createSshService(createFakeHost({ pidFileSettle: 'after-delay' }).deps)
    const overview = await service.setServiceEnabled(true)
    expect(overview.enabled).toBe(true)
    expect(overview.status).toBe('running')
  })

  it('状态迟迟不收敛时报中文错误，且不记启停时间', async () => {
    const service = createSshService(createFakeHost({ pidFile: true, pidFileSettle: 'never' }).deps)
    await expect(service.setServiceEnabled(false)).rejects.toThrow('停止 sshd 未生效')
    expect((await service.overview()).changedAt).toBeNull()
  })

  it('listLoginRecords 按时间倒序返回', async () => {
    const service = createSshService(createFakeHost({ sshdLog: LOG }).deps)
    const records = await service.listLoginRecords()
    expect(records.map((record) => record.user)).toEqual(['root', 'root', 'ops', 'ops'])
    const times = records.map((record) => Date.parse(record.at))
    expect([...times].sort((a, b) => b - a)).toEqual(times)
  })

  /**
   * 容器实际形态的回归：`sshd -E /var/log/sshd.log` 直写的裸行（无 syslog 前缀）
   * 也必须进入登录记录——否则从容器启动起记录恒为空，统计恒为零。
   */
  it('sshd -E 裸行日志同样产出登录记录，无时间戳行的 at 取首次观察时间且跨读取稳定', async () => {
    const host = createFakeHost({
      pidFile: true,
      sshdLog: [
        'Server listening on 0.0.0.0 port 73.',
        'Accepted publickey for elysian from ::1 port 41234 ssh2: ED25519 SHA256:abcd',
        'Failed password for invalid user admin from 203.0.113.9 port 41236 ssh2',
      ].join('\n'),
    })
    const service = createSshService(host.deps)

    const first = await service.listLoginRecords()
    expect(first).toHaveLength(2)
    expect(first[0]).toMatchObject({ user: 'admin', ip: '203.0.113.9', port: 41236, result: 'failed' })
    expect(first[1]).toMatchObject({ user: 'elysian', ip: '::1', port: 41234, result: 'succeeded' })

    // at 稳定：同一条裸行的登录时间不随再次读取漂移，历史记录不会全部涌进今日窗口。
    const second = await service.listLoginRecords()
    expect(second.map((record) => record.at)).toEqual(first.map((record) => record.at))

    // 统计随裸行增长：今日成功 1、失败 1。
    const overview = await service.overview()
    expect(overview.stats.today).toEqual({ succeeded: 1, failed: 1 })
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

  it('resetRootPassword：含换行或控制字符的密码拒绝且不触达 chpasswd', async () => {
    const host = createFakeHost({ sshdConfig: BASE_CONFIG })
    const service = createSshService(host.deps)

    // 强度达标但夹带第二行改密记录：chpasswd 按行解析「账号:密码」，
    // 若原样写进 stdin 会越界改掉 attacker 的密码。
    await expect(service.resetRootPassword('Elysian#2026\nattacker:P@ssw0rd123')).rejects.toThrow(
      '密码不能包含换行或控制字符',
    )
    await expect(service.resetRootPassword('Elysian#2026\rRoot')).rejects.toThrow('密码不能包含换行或控制字符')
    await expect(service.resetRootPassword('Elysian#2026\u0000')).rejects.toThrow('密码不能包含换行或控制字符')
    expect(host.chpasswdInputs).toEqual([])
  })

  it('rootAuth：authorized_keys 为空时 key 为 null（尚未生成）', async () => {
    const service = createSshService(createFakeHost({ sshdConfig: 'PermitRootLogin prohibit-password\n' }).deps)
    const auth = await service.rootAuth()
    expect(auth.policy).toBe('prohibit-password')
    expect(auth.key).toBeNull()
    expect(auth.passwordResetAt).toBeNull()
  })

  it('rootAuth：PermitRootLogin 用废弃别名 without-password 时归一为 prohibit-password，不再报错', async () => {
    const service = createSshService(createFakeHost({ sshdConfig: 'PermitRootLogin without-password\n' }).deps)
    expect((await service.rootAuth()).policy).toBe('prohibit-password')
  })

  it('rootAuth：authorized_keys 首行无法验证时跳到首个可验证行；全部无效时 key 为 null', async () => {
    const host = createFakeHost({ sshdConfig: 'PermitRootLogin prohibit-password\n' })
    host.files.set('/root/.ssh/authorized_keys', '坏行没有算法段\nssh-ed25519 AAAAroot占位 root@legacy\n')
    const service = createSshService(host.deps)
    const auth = await service.rootAuth()
    expect(auth.key?.publicKey).toBe('ssh-ed25519 AAAAroot占位 root@legacy')

    host.files.set('/root/.ssh/authorized_keys', '只剩脏行\n')
    expect((await service.rootAuth()).key).toBeNull()
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

    // 首行被新公钥替换，外来公钥行原样保留；权限收紧与属主落位和登录密钥同规。
    const text = host.files.get('/root/.ssh/authorized_keys') ?? ''
    expect(text).toBe(`${generated.key?.publicKey}\nssh-ed25519 AAAA外来 foreign@example\n`)
    expect(host.modes.get('/root/.ssh')).toBe(0o700)
    expect(host.modes.get('/root/.ssh/authorized_keys')).toBe(0o600)
    expect(host.owners.get('/root/.ssh')).toEqual({ uid: 0, gid: 0 })
    expect(host.owners.get('/root/.ssh/authorized_keys')).toEqual({ uid: 0, gid: 0 })

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

    // 属主落位：dev 容器以 root 运行，root 属主的 authorized_keys 会被 sshd
    // 以目标用户 euid 读取失败（公钥登录 Permission denied），必须 chown 到账号名下。
    expect(host.owners.get('/home/ops/.ssh')).toEqual({ uid: 1000, gid: 1000 })
    expect(host.owners.get(OPS_AUTHORIZED_KEYS)).toEqual({ uid: 1000, gid: 1000 })

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

  it('同一公钥行装在多个账号：id 含账号维度，按 id 删除只撤销目标账号', async () => {
    const host = createFakeHost({
      sshdConfig: BASE_CONFIG,
      passwd: `${DEFAULT_PASSWD}\ndev:x:1001:1001::/home/dev:/bin/bash`,
    })
    const foreign = 'ssh-ed25519 AAAA外来占位 old-laptop'
    host.files.set(OPS_AUTHORIZED_KEYS, `${foreign}\n`)
    host.files.set('/home/dev/.ssh/authorized_keys', `${foreign}\n`)
    const service = createSshService(host.deps)

    const keys = await service.listKeys()
    expect(keys).toHaveLength(2)
    // 同一行内容在两个账号下 id 必须不同，DELETE 按 id 才能各删各的。
    expect(new Set(keys.map((key) => key.id)).size).toBe(2)
    const devKey = keys.find((key) => key.userId === 'dev')
    if (!devKey) throw new Error('测试前提失败：dev 账号未列出密钥')

    await service.removeKey(devKey.id)
    expect((host.files.get('/home/dev/.ssh/authorized_keys') ?? '').trim()).toBe('')
    // 无辜账号的同款公钥保留，授权未被误删。
    expect((host.files.get(OPS_AUTHORIZED_KEYS) ?? '').trim()).toBe(foreign)
  })

  it('并发 createKey 排队落盘：两把密钥都留在 authorized_keys，不发生后写覆盖前写', async () => {
    const host = createFakeHost({ sshdConfig: BASE_CONFIG })
    const service = createSshService(host.deps)

    const [first, second] = await Promise.all([
      service.createKey({ name: '部署机', userId: 'ops' }),
      service.createKey({ name: '跳板机', userId: 'ops' }),
    ])
    // 私钥只在创建响应里一次性带出：丢掉任何一条公钥行都意味着那把私钥永久作废。
    const text = host.files.get(OPS_AUTHORIZED_KEYS) ?? ''
    expect(text).toContain(first.publicKey)
    expect(text).toContain(second.publicKey)
    const names = (await service.listKeys()).map((key) => key.name)
    expect(names).toEqual(expect.arrayContaining(['部署机', '跳板机']))
  })

  it('authorized_keys 有无法验证的脏行：列表跳过并计数，不整体报错；密钥创建不受连累', async () => {
    const host = createFakeHost({ sshdConfig: BASE_CONFIG })
    const foreign = 'ssh-ed25519 AAAA外来占位 old-laptop'
    // 畸形行对齐真实语义：ssh-keygen -lf 对它失败（fake 同样按形状拒绝）。
    host.files.set(OPS_AUTHORIZED_KEYS, `这行不是公钥\n${foreign}\n又一行坏的\n`)
    const service = createSshService(host.deps)

    const report = await service.listKeysWithReport()
    expect(report.keys.map((key) => key.publicKey)).toEqual([foreign])
    expect(report.ignoredInvalidLines).toBe(2)
    // 契约方法不变：listKeys 仍只返回数组，脏行不把整个面板拖进错误态。
    expect((await service.listKeys()).map((key) => key.publicKey)).toEqual([foreign])

    // 创建入口照常可用：新公钥正常落盘，脏行计数维持。
    const created = await service.createKey({ name: '新机', userId: 'ops' })
    const after = await service.listKeysWithReport()
    expect(after.ignoredInvalidLines).toBe(2)
    expect(after.keys.map((key) => key.publicKey)).toContain(created.publicKey)
    const text = host.files.get(OPS_AUTHORIZED_KEYS) ?? ''
    expect(text).toContain('这行不是公钥')
  })

  it('互斥队列中的失败不阻塞后续密钥操作', async () => {
    const host = createFakeHost({ sshdConfig: BASE_CONFIG })
    const service = createSshService(host.deps)

    await service.createKey({ name: '同名', userId: 'ops' })
    await expect(service.createKey({ name: '同名', userId: 'ops' })).rejects.toThrow('密钥名称已存在')
    await expect(service.createKey({ name: '另一把', userId: 'ops' })).resolves.toMatchObject({ name: '另一把' })
  })
})
