import { describe, expect, it } from 'vitest'
import { createUsersService, type UsersHostDeps } from './usersService'

/*
 * 用户管理服务编排的行为测试：全部系统访问走有状态 fake（内存 passwd/shadow/group
 * 与命令账本），不执行任何真实命令。fake 严格对齐真实命令语义——getent 首参必须是
 * 数据库名、chpasswd 按行协议解析 stdin、useradd 校验用户名合法性与重复、
 * userdel 不接受任何参数——编排一旦用错命令形状，测试立刻红。
 */

/** 本地时构造基准时间：过期判定与机器时区无关。 */
const NOW = new Date(2026, 8, 20, 12, 0, 0).toISOString()

/** fake 的用户态：getent 三个库的真实形状。 */
type FakePasswdRow = { uid: number; gid: number; gecos: string; home: string; shell: string }
type FakeShadowRow = { hash: string; expireDays: string }

type FakeUsersHost = {
  deps: UsersHostDeps
  commands: { command: string; args: readonly string[] }[]
  chpasswdInputs: string[]
  files: Map<string, string>
  passwd: Map<string, FakePasswdRow>
  shadow: Map<string, FakeShadowRow>
  groups: Map<string, Set<string>>
}

function createFakeHost(seed: {
  passwd?: Record<string, FakePasswdRow>
  shadow?: Record<string, FakeShadowRow>
  sudoMembers?: string[]
  files?: Record<string, string>
} = {}): FakeUsersHost {
  const commands: { command: string; args: readonly string[] }[] = []
  const chpasswdInputs: string[] = []
  const files = new Map(Object.entries(seed.files ?? {}))
  const passwd = new Map(Object.entries(seed.passwd ?? {}))
  const shadow = new Map(Object.entries(seed.shadow ?? {}))
  const groups = new Map<string, Set<string>>([['sudo', new Set(seed.sudoMembers ?? [])]])
  let nextUid = 2000

  const passwdLine = (name: string): string => {
    const row = passwd.get(name)!
    return `${name}:x:${row.uid}:${row.gid}:${row.gecos}:${row.home}:${row.shell}`
  }
  const shadowLine = (name: string): string => {
    const row = shadow.get(name)!
    return `${name}:${row.hash}:20000:0:99999:7::${row.expireDays}`
  }
  const groupLine = (name: string): string => {
    const members = groups.get(name)!
    return `${name}:x:${name === 'sudo' ? 27 : 100}:${[...members].join(',')}`
  }

  /** 严格解析「选项（可带值）+ 末尾位置参数」；出现未知选项立即抛错，模拟真实命令的拒绝。 */
  function parseOptions(
    args: readonly string[],
    spec: Record<string, 'flag' | 'value'>,
    command: string,
  ): { options: Record<string, string | true>; positional: string[] } {
    const options: Record<string, string | true> = {}
    const positional: string[] = []
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]!
      if (arg.startsWith('-') && arg.length > 1) {
        const kind = spec[arg]
        if (kind === undefined) throw new Error(`${command}: 不支持的参数 ${arg}`)
        if (kind === 'value') {
          index += 1
          const value = args[index]
          if (typeof value !== 'string') throw new Error(`${command}: 选项 ${arg} 缺少取值`)
          options[arg] = value
        } else {
          options[arg] = true
        }
      } else {
        positional.push(arg)
      }
    }
    return { options, positional }
  }

  const deps: UsersHostDeps = {
    async runGetent(args) {
      commands.push({ command: 'getent', args })
      // 对齐真 getent 语义：首参是数据库名而非账号名——`getent root` 在真实环境报 Unknown database。
      const [database, name] = args
      if (database !== 'passwd' && database !== 'shadow' && database !== 'group') {
        throw new Error(`Unknown database: ${database ?? ''}`)
      }
      const rows =
        database === 'passwd' ? [...passwd.keys()].map(passwdLine)
        : database === 'shadow' ? [...shadow.keys()].map(shadowLine)
        : [...groups.keys()].map(groupLine)
      if (name === undefined) return rows.length > 0 ? `${rows.join('\n')}\n` : ''
      const matched = rows.filter((line) => line.startsWith(`${name}:`))
      return matched.length > 0 ? `${matched.join('\n')}\n` : ''
    },
    async runUseradd(args) {
      commands.push({ command: 'useradd', args })
      const { options, positional } = parseOptions(args, { '-m': 'flag', '-s': 'value', '-c': 'value' }, 'useradd')
      const name = positional[0]
      if (positional.length !== 1 || !name) throw new Error('useradd: 未指定用户名')
      // 真实 useradd 拒绝不符合命名规则的用户名。
      if (!/^[a-z_][a-z0-9_-]*$/.test(name)) throw new Error(`useradd: invalid user name '${name}'`)
      if (passwd.has(name)) throw new Error(`useradd: user '${name}' already exists`)
      const uid = nextUid
      nextUid += 1
      passwd.set(name, {
        uid,
        gid: uid,
        gecos: typeof options['-c'] === 'string' ? options['-c'] : '',
        home: `/home/${name}`,
        shell: typeof options['-s'] === 'string' ? options['-s'] : '/bin/sh',
      })
      // 真实 useradd 建出的账号没有可用密码：shadow 里是锁定占位。
      shadow.set(name, { hash: '!', expireDays: '' })
      return ''
    },
    async runUsermod(args) {
      commands.push({ command: 'usermod', args })
      const { options, positional } = parseOptions(args, { '-c': 'value', '-s': 'value', '-e': 'value', '-L': 'flag' }, 'usermod')
      const name = positional[0]
      if (positional.length !== 1 || !name) throw new Error('usermod: 未指定用户名')
      const row = passwd.get(name)
      if (!row) throw new Error(`usermod: user '${name}' does not exist`)
      const shadowRow = shadow.get(name) ?? { hash: '', expireDays: '' }
      if (typeof options['-c'] === 'string') row.gecos = options['-c']
      if (typeof options['-s'] === 'string') row.shell = options['-s']
      if (typeof options['-e'] === 'string') shadowRow.expireDays = options['-e']
      if (options['-L'] === true) shadowRow.hash = shadowRow.hash.startsWith('!') ? shadowRow.hash : `!${shadowRow.hash}`
      shadow.set(name, shadowRow)
      return ''
    },
    async runUserdel(args) {
      commands.push({ command: 'userdel', args })
      // 面板约定绝不用 -r：fake 对任何参数都拒绝，只接受裸用户名。
      if (args.length !== 1 || !args[0] || args[0].startsWith('-')) {
        throw new Error(`userdel: 不支持的参数 ${args.join(' ')}`)
      }
      const name = args[0]
      if (!passwd.has(name)) throw new Error(`userdel: user '${name}' does not exist`)
      passwd.delete(name)
      shadow.delete(name)
      return ''
    },
    async runGpasswd(args) {
      commands.push({ command: 'gpasswd', args })
      const [flag, name, group] = args
      if (flag !== '-a' && flag !== '-d') throw new Error(`gpasswd: 不支持的参数 ${flag ?? ''}`)
      if (!name || !group) throw new Error('gpasswd: 参数不足')
      const members = groups.get(group)
      if (!members) throw new Error(`gpasswd: group '${group}' does not exist`)
      if (!passwd.has(name)) throw new Error(`gpasswd: user '${name}' does not exist`)
      if (flag === '-a') members.add(name)
      else members.delete(name)
      return ''
    },
    async runChpasswd(input) {
      chpasswdInputs.push(input)
      // 对齐真 chpasswd 的行协议：逐行解析「账号:密码」，首个冒号前是账号、其后整段是密码。
      const lines = input.split('\n')
      if (lines[lines.length - 1] === '') lines.pop()
      if (lines.length !== 1) throw new Error(`chpasswd: 输入了 ${lines.length} 行，面板只允许一行`)
      const line = lines[0]!
      const separator = line.indexOf(':')
      if (separator <= 0 || separator === line.length - 1) {
        throw new Error('chpasswd: 非法的输入行')
      }
      const name = line.slice(0, separator)
      const password = line.slice(separator + 1)
      if (!passwd.has(name)) throw new Error(`chpasswd: user '${name}' does not exist`)
      // PAM 换出哈希：fake 用固定占位哈希表示「密码已设置」。
      shadow.get(name)!.hash = `$fake$${password.length}$`
      return ''
    },
    async readText(path) {
      const content = files.get(path)
      if (content === undefined) throw new Error(`ENOENT: ${path}`)
      return content
    },
    async exists(path) {
      return files.has(path)
    },
    nowIso: () => NOW,
  }

  return { deps, commands, chpasswdInputs, files, passwd, shadow, groups }
}

/** 容器实际形态的种子：ubuntu(1000) 在 sudo 组且有可用密码，elysian(1001) 密码锁定但有密钥。 */
function createSeededHost(): FakeUsersHost {
  return createFakeHost({
    passwd: {
      root: { uid: 0, gid: 0, gecos: 'root', home: '/root', shell: '/bin/bash' },
      ubuntu: { uid: 1000, gid: 1000, gecos: 'Ubuntu User', home: '/home/ubuntu', shell: '/bin/bash' },
      elysian: { uid: 1001, gid: 1001, gecos: '', home: '/home/elysian', shell: '/bin/bash' },
      svc: { uid: 999, gid: 999, gecos: '', home: '/home/svc', shell: '/usr/sbin/nologin' },
      far: { uid: 60001, gid: 60001, gecos: '', home: '/home/far', shell: '/bin/bash' },
      nobody: { uid: 65534, gid: 65534, gecos: 'nobody', home: '/nonexistent', shell: '/usr/sbin/nologin' },
    },
    shadow: {
      root: { hash: '$6$roothash', expireDays: '' },
      ubuntu: { hash: '$6$ubuntuhash', expireDays: '' },
      elysian: { hash: '!', expireDays: '' },
      svc: { hash: '*', expireDays: '' },
      far: { hash: '*', expireDays: '' },
      nobody: { hash: '*', expireDays: '' },
    },
    sudoMembers: ['ubuntu'],
    files: { '/home/elysian/.ssh/authorized_keys': 'ssh-ed25519 AAAA面板密钥 elysian-root\n' },
  })
}

/** 写命令账本：保护边界用例用它断言「拒绝时零命令执行」（读命令 getent 不算）。 */
function writeCommands(host: FakeUsersHost) {
  return host.commands.filter((entry) => entry.command !== 'getent')
}

describe('createUsersService 读取', () => {
  it('list：只含 uid 1000-60000 的账号，root/svc/far/nobody 都不在；按名字升序', async () => {
    const host = createSeededHost()
    const service = createUsersService(host.deps)
    const users = await service.list()
    expect(users.map((user) => user.name)).toEqual(['elysian', 'ubuntu'])
    expect(users.find((user) => user.name === 'ubuntu')).toEqual({
      id: 'ubuntu',
      name: 'ubuntu',
      isAdmin: true,
      loginMethod: 'password',
      status: 'active',
      note: 'Ubuntu User',
      createdAt: null,
    })
    // 密码锁定但有密钥：如实推导为 key；GECOS 为空 → note null。
    expect(users.find((user) => user.name === 'elysian')).toMatchObject({
      isAdmin: false,
      loginMethod: 'key',
      note: null,
      createdAt: null,
    })
  })

  it('syncFromSystem 即重读系统：总数与 list 一致', async () => {
    const host = createSeededHost()
    const service = createUsersService(host.deps)
    const { total } = await service.syncFromSystem()
    expect(total).toBe((await service.list()).length)
  })
})

describe('createUsersService 创建', () => {
  it('创建编排：useradd 参数数组、sudo 组、chpasswd stdin，回读返回真实状态', async () => {
    const host = createSeededHost()
    const service = createUsersService(host.deps)

    const created = await service.create({
      name: 'newops',
      loginMethod: 'password',
      status: 'active',
      isAdmin: true,
      note: '值班账号',
      password: 'Elysian#2026Strong',
    })

    expect(host.commands).toContainEqual({
      command: 'useradd',
      args: ['-m', '-s', '/bin/bash', '-c', '值班账号', 'newops'],
    })
    expect(host.commands).toContainEqual({ command: 'gpasswd', args: ['-a', 'newops', 'sudo'] })
    expect(host.chpasswdInputs).toEqual(['newops:Elysian#2026Strong'])
    // 密码绝不进命令行：全部命令参数都不含密码明文。
    for (const entry of host.commands) {
      expect(entry.args.join(' ')).not.toContain('Elysian#2026Strong')
    }

    // 回读而非乐观值：返回的就是下一次 list 能看到的同一条账号。
    expect(created).toEqual({
      id: 'newops',
      name: 'newops',
      isAdmin: true,
      loginMethod: 'password',
      status: 'active',
      note: '值班账号',
      createdAt: null,
    })
    expect((await service.list()).find((user) => user.name === 'newops')).toEqual(created)
  })

  it('禁止登录且无备注：shell 用 /sbin/nologin、省 -c；停用组合追加 usermod -e 1 -L', async () => {
    const host = createSeededHost()
    const service = createUsersService(host.deps)

    const created = await service.create({
      name: 'backup',
      loginMethod: 'none',
      status: 'disabled',
      isAdmin: false,
      note: null,
    })

    expect(host.commands).toContainEqual({ command: 'useradd', args: ['-m', '-s', '/sbin/nologin', 'backup'] })
    expect(host.commands).toContainEqual({ command: 'usermod', args: ['-e', '1', '-L', 'backup'] })
    expect(host.chpasswdInputs).toEqual([])
    expect(host.commands.filter((entry) => entry.command === 'gpasswd')).toEqual([])
    // 回读如实呈现：停用账号、无密码无密钥即没有任何可用登录方式。
    expect(created).toMatchObject({ loginMethod: 'none', status: 'disabled', note: null, isAdmin: false })
  })

  it('密钥登录的账号刚建好还没有密钥：回读如实为 none，不呈现请求的样子', async () => {
    const host = createSeededHost()
    const service = createUsersService(host.deps)
    const created = await service.create({
      name: 'deploy',
      loginMethod: 'key',
      status: 'active',
      isAdmin: false,
      note: null,
    })
    expect(host.commands).toContainEqual({ command: 'useradd', args: ['-m', '-s', '/bin/bash', 'deploy'] })
    expect(created.loginMethod).toBe('none')
  })

  it('用户名非法、重名、系统已存在：拒绝且零写命令', async () => {
    const host = createSeededHost()
    const service = createUsersService(host.deps)
    const base = { loginMethod: 'key', status: 'active', isAdmin: false, note: null } as const

    await expect(service.create({ name: 'ChenYi', ...base })).rejects.toThrow('用户名只能用小写字母')
    await expect(service.create({ name: '2ops', ...base })).rejects.toThrow('用户名只能用小写字母')
    await expect(service.create({ name: 'ubuntu', ...base })).rejects.toThrow('用户名已存在：ubuntu')
    expect(writeCommands(host)).toEqual([])
  })

  it('登录方式含密码时初始密码必填；不含密码时夹带密码拒绝', async () => {
    const host = createSeededHost()
    const service = createUsersService(host.deps)

    await expect(
      service.create({ name: 'nopwuser', loginMethod: 'password', status: 'active', isAdmin: false, note: null }),
    ).rejects.toThrow('登录方式含密码时必须填写初始密码')
    await expect(
      service.create({
        name: 'keyonly',
        loginMethod: 'key',
        status: 'active',
        isAdmin: false,
        note: null,
        password: 'Elysian#2026Strong',
      }),
    ).rejects.toThrow('登录方式不含密码时不能设置密码')
    expect(writeCommands(host)).toEqual([])
  })
})

describe('createUsersService 修改', () => {
  it('各字段分别落命令：备注、sudo 组、shell、密码', async () => {
    const host = createSeededHost()
    const service = createUsersService(host.deps)
    // elysian 当前：非管理员、/bin/bash、密码锁定、有密钥。
    const updated = await service.update('elysian', {
      loginMethod: 'password-or-key',
      status: 'active',
      isAdmin: true,
      note: '面板账号',
      password: 'Elysian#2026New',
    })

    expect(host.commands).toContainEqual({ command: 'usermod', args: ['-c', '面板账号', 'elysian'] })
    expect(host.commands).toContainEqual({ command: 'gpasswd', args: ['-a', 'elysian', 'sudo'] })
    // shell 已是 /bin/bash，不再执行 usermod -s。
    expect(host.commands).not.toContainEqual({ command: 'usermod', args: ['/bin/bash', 'elysian'] })
    expect(host.chpasswdInputs).toEqual(['elysian:Elysian#2026New'])
    for (const entry of host.commands) {
      expect(entry.args.join(' ')).not.toContain('Elysian#2026New')
    }
    // 回读：新密码可用、密钥仍在 → password-or-key；备注与管理员归属都生效。
    expect(updated).toEqual({
      id: 'elysian',
      name: 'elysian',
      isAdmin: true,
      loginMethod: 'password-or-key',
      status: 'active',
      note: '面板账号',
      createdAt: null,
    })
  })

  it('登录方式改为 none：shell 换 /sbin/nologin；从含密码改为不含密码追加 usermod -L', async () => {
    const host = createSeededHost()
    const service = createUsersService(host.deps)
    await service.create({
      name: 'pwuser',
      loginMethod: 'password',
      status: 'active',
      isAdmin: false,
      note: null,
      password: 'Elysian#2026Strong',
    })

    const updated = await service.update('pwuser', {
      loginMethod: 'none',
      status: 'active',
      isAdmin: false,
      note: null,
    })

    expect(host.commands).toContainEqual({ command: 'usermod', args: ['-s', '/sbin/nologin', 'pwuser'] })
    expect(host.commands).toContainEqual({ command: 'usermod', args: ['-L', 'pwuser'] })
    // shell 为 nologin 后登录方式恒为 none。
    expect(updated.loginMethod).toBe('none')
    // 密码字段已被锁定：哈希带 ! 前缀。
    expect(host.shadow.get('pwuser')!.hash.startsWith('!')).toBe(true)
  })

  it('管理员降级：gpasswd -d 移出 sudo 组', async () => {
    const host = createSeededHost()
    const service = createUsersService(host.deps)
    const updated = await service.update('ubuntu', {
      loginMethod: 'password',
      status: 'active',
      isAdmin: false,
      note: 'Ubuntu User',
    })
    expect(host.commands).toContainEqual({ command: 'gpasswd', args: ['-d', 'ubuntu', 'sudo'] })
    expect(updated.isAdmin).toBe(false)
    // 未变更的备注不再执行 usermod -c。
    expect(host.commands).not.toContainEqual({ command: 'usermod', args: ['-c', 'Ubuntu User', 'ubuntu'] })
  })

  it('停用：usermod -e 1 -L；恢复 active：usermod -e 清空过期日', async () => {
    const host = createSeededHost()
    const service = createUsersService(host.deps)
    await service.create({
      name: 'tmpuser',
      loginMethod: 'password',
      status: 'active',
      isAdmin: false,
      note: null,
      password: 'Elysian#2026Strong',
    })

    const disabled = await service.update('tmpuser', {
      loginMethod: 'password',
      status: 'disabled',
      isAdmin: false,
      note: null,
    })
    expect(host.commands).toContainEqual({ command: 'usermod', args: ['-e', '1', '-L', 'tmpuser'] })
    expect(disabled.status).toBe('disabled')

    // 恢复必须换新密码（当前密码已被 -L 锁定）。
    await expect(
      service.update('tmpuser', { loginMethod: 'password', status: 'active', isAdmin: false, note: null }),
    ).rejects.toThrow('当前密码已锁定，请填写新密码后再启用密码登录')

    const active = await service.update('tmpuser', {
      loginMethod: 'password',
      status: 'active',
      isAdmin: false,
      note: null,
      password: 'Elysian#2026Rotate',
    })
    expect(host.commands).toContainEqual({ command: 'usermod', args: ['-e', '', 'tmpuser'] })
    expect(active.status).toBe('active')
    expect(active.loginMethod).toBe('password')
  })
})

describe('createUsersService 保护边界与注入拒绝', () => {
  it('root、uid 越界与不存在的账号一律拒绝，且零写命令执行', async () => {
    const host = createSeededHost()
    const service = createUsersService(host.deps)
    const input = { loginMethod: 'key', status: 'active', isAdmin: false, note: null } as const

    await expect(service.update('root', input)).rejects.toThrow('拒绝操作系统账号：root')
    await expect(service.remove('root')).rejects.toThrow('拒绝操作系统账号：root')
    await expect(service.update('svc', input)).rejects.toThrow('拒绝操作系统账号：svc')
    await expect(service.update('far', input)).rejects.toThrow('拒绝操作系统账号：far')
    await expect(service.update('ghost', input)).rejects.toThrow('未找到系统账号：ghost')
    await expect(service.remove('ghost')).rejects.toThrow('未找到系统账号：ghost')
    expect(writeCommands(host)).toEqual([])
  })

  it('GECOS 注入：换行、控制字符与逗号拒绝，useradd 一次都不执行', async () => {
    const host = createSeededHost()
    const service = createUsersService(host.deps)
    const base = { loginMethod: 'key', status: 'active', isAdmin: false } as const

    await expect(service.create({ name: 'inject1', ...base, note: '值班\nroot:x:0:0::/:/bin/sh' })).rejects.toThrow(
      '备注不能包含换行或控制字符',
    )
    await expect(service.create({ name: 'inject2', ...base, note: '值\u0000班' })).rejects.toThrow(
      '备注不能包含换行或控制字符',
    )
    await expect(service.create({ name: 'inject3', ...base, note: '张三,,,,运维' })).rejects.toThrow(
      '备注不能包含逗号（GECOS 里逗号用于分字段）',
    )
    await expect(
      service.update('ubuntu', { loginMethod: 'password', status: 'active', isAdmin: true, note: '备注,含逗号' }),
    ).rejects.toThrow('备注不能包含逗号')
    expect(writeCommands(host)).toEqual([])
  })

  it('密码弱或含换行/控制字符：拒绝且不触达 chpasswd', async () => {
    const host = createSeededHost()
    const service = createUsersService(host.deps)
    const base = { loginMethod: 'password', status: 'active', isAdmin: false, note: null } as const

    await expect(service.create({ name: 'weakpw', ...base, password: 'abcdefgh' })).rejects.toThrow('密码强度不足')
    // 强度达标但夹带第二行改密记录：chpasswd 按行解析「账号:密码」，原样写进 stdin
    // 会越界改掉 attacker 的密码——SSH 评审修过的同型漏洞。
    await expect(
      service.create({ name: 'injpw', ...base, password: 'Elysian#2026\nattacker:P@ssw0rd123' }),
    ).rejects.toThrow('密码不能包含换行或控制字符')
    await expect(service.create({ name: 'ctrlpw', ...base, password: 'Elysian#2026\u0000' })).rejects.toThrow(
      '密码不能包含换行或控制字符',
    )
    expect(host.chpasswdInputs).toEqual([])
  })
})

describe('createUsersService 删除', () => {
  it('userdel 不带 -r（主目录保留），删除后回读确认', async () => {
    const host = createSeededHost()
    const service = createUsersService(host.deps)
    await service.remove('ubuntu')

    expect(host.commands).toContainEqual({ command: 'userdel', args: ['ubuntu'] })
    // 绝不带 -r：所有 userdel 调用都只有一个裸用户名参数。
    for (const entry of host.commands.filter((command) => command.command === 'userdel')) {
      expect(entry.args).toHaveLength(1)
    }
    expect((await service.list()).map((user) => user.name)).toEqual(['elysian'])
    expect((await service.syncFromSystem()).total).toBe(1)
    // 再删同一个账号：系统里已没有，如实拒绝。
    await expect(service.remove('ubuntu')).rejects.toThrow('未找到系统账号：ubuntu')
  })
})

describe('fake 的严格性（getent 教训）', () => {
  it('getent 首参必须是数据库名：把账号名当数据库用会抛 Unknown database', async () => {
    const host = createSeededHost()
    await expect(host.deps.runGetent(['root'])).rejects.toThrow('Unknown database: root')
    await expect(host.deps.runGetent(['passwd', 'root'])).resolves.toContain('root:x:0:0:')
  })

  it('chpasswd 按行协议解析 stdin：第二行或非法行抛错', async () => {
    const host = createSeededHost()
    await expect(host.deps.runChpasswd('ubuntu:新密码\nattacker:P@ssw0rd123')).rejects.toThrow('面板只允许一行')
    await expect(host.deps.runChpasswd('非法行没有冒号')).rejects.toThrow('非法的输入行')
    await expect(host.deps.runChpasswd(':缺账号')).rejects.toThrow('非法的输入行')
    await expect(host.deps.runChpasswd('ghost:不存在账号')).rejects.toThrow("chpasswd: user 'ghost' does not exist")
  })

  it('useradd 校验用户名合法性与重复；不支持的参数拒绝', async () => {
    const host = createSeededHost()
    await expect(host.deps.runUseradd(['-m', '-s', '/bin/bash', 'Bad Name'])).rejects.toThrow("invalid user name 'Bad Name'")
    await expect(host.deps.runUseradd(['-m', 'ubuntu'])).rejects.toThrow("user 'ubuntu' already exists")
    await expect(host.deps.runUseradd(['-r', 'svc'])).rejects.toThrow('不支持的参数 -r')
  })

  it('userdel 只接受裸用户名；gpasswd 校验账号与组存在', async () => {
    const host = createSeededHost()
    await expect(host.deps.runUserdel(['-r', 'ubuntu'])).rejects.toThrow('不支持的参数 -r')
    await expect(host.deps.runGpasswd(['-a', 'ghost', 'sudo'])).rejects.toThrow("gpasswd: user 'ghost' does not exist")
    await expect(host.deps.runGpasswd(['-a', 'ubuntu', 'wheel'])).rejects.toThrow("gpasswd: group 'wheel' does not exist")
  })
})
