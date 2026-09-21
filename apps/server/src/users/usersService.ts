import type { HostUser, HostUserInput, UserAdapter } from '@elysian/contracts'
import { evaluateSshPasswordStrength, isValidHostUserName } from '@elysian/contracts'
import { invalidRequest } from '../shared/errors.ts'
import { authorizedKeysPath } from '../shared/authorizedKeys.ts'
import { hasUnsafeControlChars } from '../shared/noteValidation.ts'
import {
  MANAGED_UID_MAX,
  MANAGED_UID_MIN,
  daysSinceEpochUtc,
  deriveHostUser,
  isNoLoginShell,
  parseGetentPasswd,
  parseGetentShadow,
  parseGroupMembers,
  noteOfGecos,
  passwordUsable,
  type PasswdRecord,
} from './parseSystemUsers'

/*
 * 用户管理的服务编排：把界面动作翻译成容器内 useradd/usermod/userdel/gpasswd/chpasswd
 * 的真实执行。全部系统访问经 deps 注入，编排逻辑在 Vitest 里用有状态 fake
 * （内存 passwd/shadow/group 与命令账本）驱动，不执行任何真实命令。
 *
 * 安全红线：
 * - 所有命令经注入的 execFile 数组传参执行，绝不拼 shell 字符串，也绝不手改
 *   /etc/passwd、/etc/shadow 或 /etc/group——命令自带文件锁与原子写。
 * - 密码只走 chpasswd 的 stdin（`账号:密码`），绝不进命令行；换行与控制字符拒绝
 *   （chpasswd 逐行解析，含换行会注入额外的改密行）。
 * - 用户名与备注双侧同判据：用户名复用契约 isValidHostUserName，备注复用防火墙的
 *   控制字符判据并额外拒逗号（GECOS 里逗号用于分字段）。
 * - 保护边界：目标账号服务端反查，root 与 uid 越出 1000-60000 的账号即使被伪造请求
 *   点名也拒绝，且不执行任何写命令。
 * - 最后一个 sudo 成员防呆：降级或删除前解析 getent group sudo 的当前成员，目标是
 *   仅剩成员时拒绝——绝不让容器里清空全部可提权账号。
 * - 每次写操作完成后回读该账号（passwd/shadow/group/authorized_keys 重新推导），
 *   绝不返回未经回读的乐观值。
 */

/** 停用登录的 shell：method 为 none 时用它挡住交互登录。 */
export const NOLOGIN_SHELL = '/sbin/nologin'
/** 允许登录的 shell：其余登录方式统一落 /bin/bash。 */
export const LOGIN_SHELL = '/bin/bash'

export type UsersHostDeps = {
  /**
   * 执行 getent（`getent passwd`、`getent shadow`、`getent group sudo` 等），返回 stdout。
   * 查无结果（真实 getent 以退出码 2 结束）由适配层归一为空输出——见 api.node 的
   * runGetentViaExecFile，服务层据此把空输出当「无此账号」处理。
   */
  runGetent(args: readonly string[]): Promise<string>
  runUseradd(args: readonly string[]): Promise<string>
  runUsermod(args: readonly string[]): Promise<string>
  runUserdel(args: readonly string[]): Promise<string>
  runGpasswd(args: readonly string[]): Promise<string>
  /** 执行 chpasswd，凭据经 stdin 传入（`账号:密码`），绝不进命令行。 */
  runChpasswd(input: string): Promise<string>
  readText(path: string): Promise<string>
  exists(path: string): Promise<boolean>
  /** 删除文件（移除 authorized_keys 用）；目录与权限错误原样抛出。 */
  remove(path: string): Promise<void>
  nowIso(): string
}

/** 登录方式是否包含密码路径。 */
function methodIncludesPassword(method: HostUserInput['loginMethod']): boolean {
  return method === 'password' || method === 'password-or-key'
}

export function createUsersService(deps: UsersHostDeps): UserAdapter {
  function commandError(command: string, args: readonly string[], error: unknown): Error {
    const detail = error instanceof Error ? error.message : String(error)
    return new Error(`${command} 执行失败（${[command, ...args].join(' ')}）：${detail}`)
  }

  /** 备注双侧判据：控制字符对照防火墙标准，逗号是 GECOS 的字段分隔符。 */
  function assertNoteSafe(note: string | null): void {
    if (note && hasUnsafeControlChars(note)) {
      throw invalidRequest('备注不能包含换行或控制字符')
    }
    if (note && note.includes(',')) {
      throw invalidRequest('备注不能包含逗号（GECOS 里逗号用于分字段）')
    }
  }

  /** 密码双侧判据：换行/控制字符拒绝（chpasswd 按行解析），强度弱拒绝。 */
  function assertPasswordSafe(password: string): void {
    if (hasUnsafeControlChars(password)) {
      throw invalidRequest('密码不能包含换行或控制字符')
    }
    const strength = evaluateSshPasswordStrength(password)
    if (strength === 'weak') {
      throw invalidRequest('密码强度不足：判定为弱密码，请加长密码并混合大小写字母、数字与符号')
    }
  }

  /**
   * 校验密码输入与登录方式的一致性：含密码的登录方式必须提供密码（创建时），
   * 不含密码的登录方式不允许夹带密码。返回归一后的密码（null 表示本次不动密码）。
   */
  function resolvePassword(input: HostUserInput, options: { required: boolean }): string | null {
    const password = input.password
    if (password !== undefined && password !== null && password !== '') {
      if (!methodIncludesPassword(input.loginMethod)) {
        throw invalidRequest('登录方式不含密码时不能设置密码')
      }
      assertPasswordSafe(password)
      return password
    }
    if (options.required && methodIncludesPassword(input.loginMethod)) {
      throw invalidRequest('登录方式含密码时必须填写初始密码')
    }
    return null
  }

  async function passwdRecords(): Promise<readonly PasswdRecord[]> {
    const output = await deps.runGetent(['passwd']).catch((error: unknown) => {
      throw commandError('getent', ['passwd'], error)
    })
    return parseGetentPasswd(output)
  }

  async function findPasswd(name: string): Promise<PasswdRecord | null> {
    const output = await deps.runGetent(['passwd', name]).catch((error: unknown) => {
      throw commandError('getent', ['passwd', name], error)
    })
    return parseGetentPasswd(output)[0] ?? null
  }

  async function shadowOf(name: string) {
    const output = await deps.runGetent(['shadow', name]).catch((error: unknown) => {
      throw commandError('getent', ['shadow', name], error)
    })
    return parseGetentShadow(output)[0] ?? null
  }

  async function sudoMembers(): Promise<ReadonlySet<string>> {
    const output = await deps.runGetent(['group', 'sudo']).catch((error: unknown) => {
      throw commandError('getent', ['group', 'sudo'], error)
    })
    return parseGroupMembers(output)
  }

  /** authorized_keys 内容：主目录只从 getent 推导，读不到（无文件）为 null。 */
  async function authorizedKeysText(entry: PasswdRecord): Promise<string | null> {
    const path = authorizedKeysPath(entry.home)
    return (await deps.exists(path)) ? deps.readText(path) : null
  }

  /** 回读单个账号并推导成视图模型；读不到时抛中文错误。 */
  async function readUser(name: string): Promise<HostUser> {
    const entry = await findPasswd(name)
    if (!entry) throw invalidRequest(`未找到系统账号：${name}`)
    const [shadow, sudo] = await Promise.all([shadowOf(name), sudoMembers()])
    return deriveHostUser({
      passwd: entry,
      shadow,
      sudoMembers: sudo,
      authorizedKeysText: await authorizedKeysText(entry),
      nowIso: deps.nowIso(),
    })
  }

  /**
   * 保护边界：按 userId 反查系统账号，反查不到或 uid 越出 1000-60000（含 root）一律拒绝。
   * 返回反查到的账号条目供后续编排使用；任何写命令都在这之后才会执行。
   */
  async function manageablePasswd(userId: string): Promise<PasswdRecord> {
    const entry = await findPasswd(userId)
    if (!entry) throw invalidRequest(`未找到系统账号：${userId}`)
    if (entry.name === 'root' || entry.uid < MANAGED_UID_MIN || entry.uid > MANAGED_UID_MAX) {
      throw invalidRequest(`拒绝操作系统账号：${userId}（仅管理 uid ${MANAGED_UID_MIN}-${MANAGED_UID_MAX} 的账号）`)
    }
    return entry
  }

  /**
   * 最后一个 sudo 成员防呆：降级或删除仅剩的管理员会让容器内再无任何可提权账号，
   * 面板自己也会被锁在门外——解析自 getent group sudo 的当前成员，目标是仅剩成员
   * 时直接拒绝，且不执行任何写命令。
   */
  function assertNotLastSudoMember(name: string, sudo: ReadonlySet<string>, action: string): void {
    if (sudo.has(name) && sudo.size <= 1) {
      throw invalidRequest(`拒绝${action} ${name}：它是 sudo 组最后一个成员，操作后容器内将没有任何可提权账号`)
    }
  }

  return {
    async list(): Promise<readonly HostUser[]> {
      const entries = (await passwdRecords()).filter((entry) => entry.uid >= MANAGED_UID_MIN && entry.uid <= MANAGED_UID_MAX)
      const [shadowOutput, sudo] = await Promise.all([
        deps.runGetent(['shadow']).catch((error: unknown) => {
          throw commandError('getent', ['shadow'], error)
        }),
        sudoMembers(),
      ])
      const shadowByName = new Map(parseGetentShadow(shadowOutput).map((record) => [record.name, record]))
      const users: HostUser[] = []
      for (const entry of entries) {
        users.push(
          deriveHostUser({
            passwd: entry,
            shadow: shadowByName.get(entry.name) ?? null,
            sudoMembers: sudo,
            authorizedKeysText: await authorizedKeysText(entry),
            nowIso: deps.nowIso(),
          }),
        )
      }
      // 创建时间恒为 null（无从取材），倒序无从谈起；按名字升序返回，排序口径稳定可解释。
      return users.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    },

    async create(input: { name: string } & HostUserInput): Promise<HostUser> {
      // 用户名判据与表单共用同一函数：界面挡一次，这里再挡一次，绕过界面也建不出账号。
      if (!isValidHostUserName(input.name)) {
        throw invalidRequest('用户名只能用小写字母、数字、下划线与连字符，且由字母或下划线开头')
      }
      if (await findPasswd(input.name)) {
        throw invalidRequest(`用户名已存在：${input.name}`)
      }
      assertNoteSafe(input.note)
      // 创建时登录方式含密码则初始密码必填；密码绝不进命令行，只走 chpasswd 的 stdin。
      const password = resolvePassword(input, { required: true })
      const name = input.name

      const useraddArgs = [
        '-m',
        '-s',
        input.loginMethod === 'none' ? NOLOGIN_SHELL : LOGIN_SHELL,
        // 无密码创建用 -p '*'（无可用密码、不锁账号）：不带 -p 的 shadow 是裸 '!'，
        // sshd(UsePAM) 对锁定账号连公钥认证都拒绝——「只能密钥登录」的账号第一次用密钥就会被打回密码提示。
        ...(password === null ? (['-p', '*'] as const) : []),
        // 备注为空时省 -c：GECOS 留空，回读推导为 null。
        ...(input.note ? (['-c', input.note] as const) : []),
        name,
      ]
      await deps.runUseradd(useraddArgs).catch((error: unknown) => {
        throw commandError('useradd', useraddArgs, error)
      })

      if (input.isAdmin) {
        const args = ['-a', name, 'sudo'] as const
        await deps.runGpasswd(args).catch((error: unknown) => {
          throw commandError('gpasswd', args, error)
        })
      }

      if (password !== null) {
        await deps.runChpasswd(`${name}:${password}`).catch((error: unknown) => {
          // 错误信息只描述命令本身：密码绝不进命令行，也不进任何日志与报错。
          throw new Error(`chpasswd 执行失败：${error instanceof Error ? error.message : String(error)}`)
        })
      }

      if (input.status === 'disabled') {
        const args = ['-e', '1', '-L', name] as const
        await deps.runUsermod(args).catch((error: unknown) => {
          throw commandError('usermod', args, error)
        })
      }

      // 回读真实状态：绝不返回命令拼出来的乐观值。
      return readUser(name)
    },

    async update(userId: string, input: HostUserInput): Promise<HostUser> {
      const entry = await manageablePasswd(userId)
      assertNoteSafe(input.note)
      const password = resolvePassword(input, { required: false })
      const [shadow, sudo] = await Promise.all([shadowOf(entry.name), sudoMembers()])
      const currentNote = noteOfGecos(entry.gecos)
      const currentIsAdmin = sudo.has(entry.name)
      // 降级仅剩的管理员先于一切写命令拒绝：不让备注、shell 等无关变更先落盘。
      if (!input.isAdmin && currentIsAdmin) {
        assertNotLastSudoMember(entry.name, sudo, '降级')
      }

      // 恢复密码登录的红线：当前没有可用密码（'!' 锁定或 '*' 占位）且未提供新密码时拒绝保存——
      // 这两种占位都没有明文可解，绝不假装恢复；要启用密码登录必须换新密码。
      if (methodIncludesPassword(input.loginMethod) && password === null) {
        const hash = shadow?.passwordHash ?? ''
        if (!passwordUsable(hash)) {
          throw invalidRequest('当前未设置可用密码，请填写新密码后再启用密码登录')
        }
      }

      if (input.note !== currentNote) {
        // note 为 null 时传空串：usermod -c '' 即清空 GECOS。
        const args = ['-c', input.note ?? '', entry.name] as const
        await deps.runUsermod(args).catch((error: unknown) => {
          throw commandError('usermod', args, error)
        })
      }

      if (input.isAdmin !== currentIsAdmin) {
        const args = [input.isAdmin ? '-a' : '-d', entry.name, 'sudo'] as const
        await deps.runGpasswd(args).catch((error: unknown) => {
          throw commandError('gpasswd', args, error)
        })
      }

      // 登录方式落到 shell：none 用 /sbin/nologin，其余统一 /bin/bash；与当前不同才执行。
      const targetShell = input.loginMethod === 'none' ? NOLOGIN_SHELL : LOGIN_SHELL
      if (entry.shell !== targetShell) {
        const args = ['-s', targetShell, entry.name] as const
        await deps.runUsermod(args).catch((error: unknown) => {
          throw commandError('usermod', args, error)
        })
      }

      if (password !== null) {
        await deps.runChpasswd(`${entry.name}:${password}`).catch((error: unknown) => {
          throw new Error(`chpasswd 执行失败：${error instanceof Error ? error.message : String(error)}`)
        })
      }

      // 登录方式从含密码改为不含密码：旧密码作废用 -p '*'，而不是 -L——
      // -L 在哈希前加 '!' 会锁定整个账号，sshd(UsePAM) 对锁定账号连公钥认证都拒绝。
      const currentMethodIncludesPassword =
        shadow !== null && !isNoLoginShell(entry.shell) && passwordUsable(shadow.passwordHash)
      if (currentMethodIncludesPassword && !methodIncludesPassword(input.loginMethod)) {
        const args = ['-p', '*', entry.name] as const
        await deps.runUsermod(args).catch((error: unknown) => {
          throw commandError('usermod', args, error)
        })
      }

      // 登录方式不含密钥（仅密码）：把该账号的 authorized_keys 真正移除——留着的公钥行
      // 仍能登录，面板呈现的「仅密码」就是假状态。与密码侧的 -p '*' 对称。
      // none 由 nologin shell 挡住一切登录，不动密钥文件。
      if (input.loginMethod === 'password') {
        const keysPath = authorizedKeysPath(entry.home)
        if (await deps.exists(keysPath)) {
          await deps.remove(keysPath).catch((error: unknown) => {
            throw commandError('unlink', [keysPath], error)
          })
        }
      }

      // 状态：停用即设过期日并锁密码（账号过期挡一切登录）；恢复只清过期日（-e ''）。
      if (input.status === 'disabled') {
        const args = ['-e', '1', '-L', entry.name] as const
        await deps.runUsermod(args).catch((error: unknown) => {
          throw commandError('usermod', args, error)
        })
      } else if (shadow !== null && shadow.expireDays !== null && shadow.expireDays <= daysSinceEpochUtc(deps.nowIso())) {
        const args = ['-e', '', entry.name] as const
        await deps.runUsermod(args).catch((error: unknown) => {
          throw commandError('usermod', args, error)
        })
      }

      return readUser(entry.name)
    },

    async remove(userId: string): Promise<void> {
      const entry = await manageablePasswd(userId)
      assertNotLastSudoMember(entry.name, await sudoMembers(), '删除')
      // 绝不带 -r：主目录保留，数据不随账号一起销毁（删除弹窗文案注明）。
      const args = [entry.name] as const
      await deps.runUserdel(args).catch((error: unknown) => {
        throw commandError('userdel', args, error)
      })
      // 回读确认：userdel 之后系统里不该再有这个账号，仍查得到即如实报错。
      if (await findPasswd(entry.name)) {
        throw new Error(`删除未生效：系统里仍存在账号 ${entry.name}`)
      }

      // 凭据不是用户数据，必须随账号销毁：userdel 不动主目录，残留的 authorized_keys
      // （含面板写入的 .bak）会在同名重建时被新账号继承——useradd 复用释放的 uid，
      // 属主恰好吻合，旧私钥即可直接登录新账号。
      const keysPath = authorizedKeysPath(entry.home)
      for (const path of [keysPath, `${keysPath}.bak`]) {
        if (!(await deps.exists(path))) continue
        await deps.remove(path).catch((error: unknown) => {
          throw commandError('unlink', [path], error)
        })
      }
    },

    async syncFromSystem(): Promise<{ total: number }> {
      // 同步即重读：list 走的就是 getent 的真实读路径。
      return { total: (await this.list()).length }
    },
  }
}
