import type {
  SshAuthMethods,
  SshAuthSettings,
  SshLoginKey,
  SshLoginRecord,
  SshOverview,
  SshPasswordResetResult,
  SshRootAuth,
  SshRootLoginPolicy,
} from '@elysian/contracts'
import {
  SSH_DEFAULT_PORT,
  SSH_KEY_NAME_MAX_LENGTH,
  SSH_ROOT_LOGIN_POLICIES,
  evaluateSshPasswordStrength,
  isValidSshKeyName,
  isValidSshPort,
} from '@elysian/contracts'
import type { SshAdapter } from '../../contracts/adapters'
import { hasUnsafeControlChars } from '../firewallHost/noteValidation'
import { parseSshdConfig, stripConfigComment, type SshdDirectiveName } from './parseSshdConfig'
import { patchSshdConfig } from './patchSshdConfig'
import { parseSshLog, summarizeSshLog } from './parseSshLog'
import {
  algorithmLabelOf,
  appendKeyLine,
  authorizedKeyId,
  authorizedKeysPath,
  isKeyAccount,
  keyCommentOf,
  keyLineId,
  listKeyAccounts,
  parseGetentPasswd,
  parseKeygenFingerprint,
  parseKeyLines,
  removeKeyLine,
  replaceFirstKeyLine,
  sshDirPath,
  type PasswdEntry,
} from './authorizedKeys'

/*
 * SSH 面板的服务编排：把界面动作翻译成容器内 sshd / ssh-keygen / chpasswd 的真实执行。
 * 全部系统访问经 deps 注入，编排逻辑在 Vitest 里用有状态 fake（内存文件与命令账本）驱动。
 *
 * 安全红线：
 * - 所有命令经注入的 execFile 数组传参执行，绝不拼 shell 字符串；密钥名称与 Root 密码
 *   都拒绝换行与控制字符（密码按行进 chpasswd 的 stdin，含换行会越界改掉其他账号）。
 * - sshd_config 只补丁四个白名单指令，写前备份、临时文件加 rename 原子落盘，
 *   `sshd -t` 预检失败立即回滚原配置——不重现「写坏配置导致服务停用」。
 *   补丁与读取都对齐 Include 语义：面板行插到 Include 之前保证 first-obtained 生效，
 *   读取时展开 sshd_config.d 后按 sshd 取值顺序呈现生效值；Port 为累积监听指令，
 *   替换首个 Port 行的同时注释掉其余未注释 Port 行。
 * - authorized_keys 行级编辑：公钥行经 ssh-keygen -lf 验证后追加/删除，.ssh 0700、文件 0600；
 *   行 id 含账号维度，同一公钥装多账号时按 id 删除只撤销目标账号；全部读-改-写进互斥队列，
 *   并发请求排队落盘，后写不覆盖前写。
 * - Root 密码只走 chpasswd 的 stdin，不进命令行参数。
 * - 私钥只在创建/生成响应里一次性带出：生成后立即读出并删除临时密钥文件，之后无处可取。
 */

export const DEFAULT_SSH_PATHS = {
  sshdConfig: '/etc/ssh/sshd_config',
  sshdLog: '/var/log/sshd.log',
  sshdPidFile: '/run/sshd.pid',
  /** ssh-keygen 的工作目录：密钥对在这里生成、验完即删，不进任何用户主目录。 */
  keygenWorkspace: '/tmp/elysian-ssh-keygen',
}

export type SshHostDeps = {
  /** 执行 ssh-keygen 子命令，返回 stdout；失败抛错（含 stderr）。 */
  runSshKeygen(args: readonly string[]): Promise<string>
  /** 执行 sshd（如 `sshd -t` 配置预检），返回 stdout。 */
  runSshd(args: readonly string[]): Promise<string>
  /**
   * 以容器既定参数启动 sshd（daemonize，自行写 pidfile）：`sshd -E <日志路径>`。
   * 不走 service ssh start——容器里 /etc/default/ssh 的 SSHD_OPTS 为空，
   * 那样启动出的 sshd 不写 /var/log/sshd.log，面板日志源随之冻结。
   */
  startSshd(): Promise<void>
  /** 停止 sshd：向 pidfile 里的主进程发 SIGTERM；没有 pidfile 时幂等成功。 */
  stopSshd(): Promise<void>
  /**
   * 让在跑的 sshd 重读配置：向主进程发 SIGHUP（re-exec 保留原启动参数，含 -E）。
   * 不走 service ssh restart，理由同 startSshd——restart 出的 sshd 会丢 -E。
   */
  reloadSshd(): Promise<void>
  /** 执行 chpasswd，凭据经 stdin 传入（`账号:密码`），绝不进命令行。 */
  runChpasswd(input: string): Promise<string>
  /** 执行 getent（如 `getent passwd`、`getent passwd root`），返回 stdout。 */
  runGetent(args: readonly string[]): Promise<string>
  /** 轮询等待一步（毫秒）：启停后等 sshd 状态收敛用；测试注入即时实现。 */
  delay(ms: number): Promise<void>
  readText(path: string): Promise<string>
  /** 列目录下的直接子项名（Include 通配展开用）；目录不存在时返回空数组。 */
  readDir(path: string): Promise<string[]>
  writeText(path: string, content: string): Promise<void>
  exists(path: string): Promise<boolean>
  /** 原子写的最后一步：临时文件改名顶替目标文件。 */
  rename(from: string, to: string): Promise<void>
  /** 收紧权限用：.ssh 0700、authorized_keys 0600。 */
  chmod(path: string, mode: number): Promise<void>
  /**
   * 属主一并落到账号名下：dev 容器以 root 运行，root 属主的 authorized_keys
   * 会被 sshd 以目标用户 euid 读取失败（公钥登录 Permission denied）。
   */
  chown(path: string, uid: number, gid: number): Promise<void>
  mkdir(path: string): Promise<void>
  /** 删除文件（密钥生成后的清理）。 */
  remove(path: string): Promise<void>
  nowIso(): string
  paths?: typeof DEFAULT_SSH_PATHS
}

/** 面板创建的密钥注释前缀：authorized_keys 里据此识别归属面板管理的名称。 */
const KEY_COMMENT_PREFIX = 'elysian-'

export function createSshService(deps: SshHostDeps): SshAdapter {
  const paths = deps.paths ?? DEFAULT_SSH_PATHS
  /** 公钥行 id → 本次会话首次观察到的时间：authorized_keys 无时间戳，创建时间是会话记忆。 */
  const keyFirstSeenAt = new Map<string, string>()
  /** Root 密码上次重置时间：chpasswd 不留可读记录，只有会话记忆。 */
  let passwordResetAt: string | null = null
  /** 服务上次启停时间：sshd 自身不记录启停，只有会话记忆；进程重启后回到 null（界面显示 —）。 */
  let lastToggleAt: string | null = null
  /** 密钥生成与指纹验证的临时文件序号：避免并发请求互踩。 */
  let tempSeq = 0
  /**
   * authorized_keys 读-改-写的互斥队列：并发的创建/删除/重生成排队执行，
   * 每次变更都基于最新落盘内容计算，杜绝「两个请求读同一份原文、后写覆盖前写」
   * 静默丢掉已生成公钥行的情况。
   */
  let keysWriteTail: Promise<unknown> = Promise.resolve()
  function serializeKeysWrite<T>(critical: () => Promise<T>): Promise<T> {
    const run = keysWriteTail.then(critical, critical)
    keysWriteTail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  function commandError(command: string, args: readonly string[], error: unknown): Error {
    const detail = error instanceof Error ? error.message : String(error)
    return new Error(`${command} 执行失败（${[command, ...args].join(' ')}）：${detail}`)
  }

  async function ensureDir(path: string): Promise<void> {
    if (!(await deps.exists(path))) await deps.mkdir(path)
  }

  async function serviceRunning(): Promise<boolean> {
    // sshd daemonize 时写 pidfile（/run/sshd.pid）；pidfile 在即视为在跑。
    return deps.exists(paths.sshdPidFile)
  }

  /**
   * 启停后轮询 pidfile 直至到达目标态：TERM 与守护进程化都异步生效，
   * 立即回查会带回过期运行态，面板的开关会被拉回旧值。预算内未收敛返回 false，由调用方如实报错。
   */
  async function waitForServiceState(running: boolean): Promise<boolean> {
    const attempts = 50
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if ((await serviceRunning()) === running) return true
      await deps.delay(100)
    }
    return (await serviceRunning()) === running
  }

  async function readConfigText(): Promise<string> {
    try {
      return await deps.readText(paths.sshdConfig)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`无法读取 sshd 配置（${paths.sshdConfig}）：${detail}`)
    }
  }

  /** Include 通配符（`*` 与 `?`，仅单段内匹配）→ 正则。 */
  function globToRegExp(pattern: string): RegExp {
    const source = pattern
      .split('')
      .map((ch) => {
        if (ch === '*') return '[^/]*'
        if (ch === '?') return '[^/]'
        return ch.replace(/[\\^$.+|()[\]{}]/g, '\\$&')
      })
      .join('')
    return new RegExp(`^${source}$`)
  }

  /**
   * 展开单个 Include 路径：相对路径以主配置所在目录为基准，含通配符时列目录按字典序
   * （sshd_config(5)：Include 按词法序处理）逐个读取；文件缺失或不可读按无内容处理。
   */
  async function expandIncludePattern(rawPattern: string, depth: number): Promise<string> {
    const configDir = paths.sshdConfig.slice(0, paths.sshdConfig.lastIndexOf('/'))
    const absolute = rawPattern.startsWith('/') ? rawPattern : `${configDir}/${rawPattern}`
    let candidates: string[]
    if (/[*?]/.test(absolute)) {
      const slash = absolute.lastIndexOf('/')
      const dir = absolute.slice(0, slash)
      const pattern = absolute.slice(slash + 1)
      const regex = globToRegExp(pattern)
      candidates = (await deps.readDir(dir))
        .filter((name) => regex.test(name))
        .sort()
        .map((name) => `${dir}/${name}`)
    } else {
      candidates = [absolute]
    }
    const parts: string[] = []
    for (const candidate of candidates) {
      if (!(await deps.exists(candidate))) continue
      const content = await deps.readText(candidate).catch(() => null)
      if (content === null) continue
      parts.push(await expandIncludes(content, depth + 1))
    }
    return parts.join('\n')
  }

  /**
   * 展开 Include 后的全量配置文本：Include 行按 sshd 语义原位替换为所引文件内容，
   * 解析顺序（first-obtained）与真实 sshd 一致，面板由此读到生效值而不是主文件值。
   * 递归深度设上限，防止 drop-in 互相 Include 成环时读挂面板。
   */
  async function expandIncludes(text: string, depth: number): Promise<string> {
    if (depth >= 16) return ''
    const out: string[] = []
    for (const rawLine of text.split('\n')) {
      const line = stripConfigComment(rawLine).trim()
      const keyword = line.split(/\s+/)[0]?.toLowerCase() ?? ''
      if (line && keyword === 'include') {
        for (const pattern of line.split(/\s+/).slice(1)) {
          out.push(await expandIncludePattern(pattern, depth))
        }
        continue
      }
      out.push(rawLine)
    }
    return out.join('\n')
  }

  /** 读取展开 Include 后的 sshd 配置文本：settings 与 Root 策略都以生效值为准。 */
  async function readEffectiveConfigText(): Promise<string> {
    return expandIncludes(await readConfigText(), 0)
  }

  /** 备份 + 临时文件 + rename 的原子写：任何时刻目标路径上要么是旧全文要么是新全文。 */
  async function writeAtomic(target: string, original: string | null, next: string): Promise<void> {
    if (original !== null) {
      await deps.writeText(`${target}.bak`, original)
    }
    const tmp = `${target}.elysian-tmp`
    await deps.writeText(tmp, next)
    await deps.rename(tmp, target)
  }

  async function settingsOf(text: string): Promise<SshAuthSettings> {
    const directives = parseSshdConfig(text)
    return {
      // 指令缺省时按 sshd 默认值呈现（sshd_config(5)：Port 22、两种认证默认开启）。
      port: directives.port ?? SSH_DEFAULT_PORT,
      passwordAuthEnabled: directives.passwordAuthentication ?? true,
      keyAuthEnabled: directives.pubkeyAuthentication ?? true,
    }
  }

  function policyOf(text: string): SshRootLoginPolicy {
    const raw = parseSshdConfig(text).permitRootLogin ?? 'prohibit-password'
    const policy = SSH_ROOT_LOGIN_POLICIES.find((candidate) => candidate === raw)
    if (!policy) {
      throw new Error(`sshd 配置里的 PermitRootLogin 取值无法识别：${raw}`)
    }
    return policy
  }

  /**
   * 白名单补丁的完整落盘流程：补丁 → 备份 → 原子写 → `sshd -t` 预检 →（在跑时）SIGHUP 重载。
   * 预检失败立即回滚原配置并抛中文错误；未改动时直接返回，不产生任何写与重载。
   * 重载用 SIGHUP 而不是 service restart：sshd re-exec 时保留原启动参数（含 -E 日志路径），
   * restart 出的 sshd 会丢 -E，面板日志源随之冻结。
   */
  async function patchAndApply(patch: Partial<Record<SshdDirectiveName, string>>): Promise<void> {
    const original = await readConfigText()
    const next = patchSshdConfig(original, patch)
    if (next === original) return

    await writeAtomic(paths.sshdConfig, original, next)
    try {
      await deps.runSshd(['-t', '-f', paths.sshdConfig]).catch((error: unknown) => {
        throw commandError('sshd', ['-t', '-f', paths.sshdConfig], error)
      })
    } catch (error) {
      await deps.writeText(paths.sshdConfig, original)
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`sshd 配置预检未通过，已回滚原配置：${detail}`)
    }

    if (await serviceRunning()) {
      try {
        await deps.reloadSshd()
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`配置已写入并通过预检，但重载 sshd 失败：${detail}`)
      }
    }
  }

  /** 无时间戳的日志行（sshd -E 裸行）→ 本次会话首次观察到的时间。 */
  const loginLineFirstSeenAt = new Map<string, string>()

  function loginLineAt(line: { source: string; at: string | null }): string {
    if (line.at !== null) return line.at
    let at = loginLineFirstSeenAt.get(line.source)
    if (!at) {
      at = deps.nowIso()
      loginLineFirstSeenAt.set(line.source, at)
    }
    return at
  }

  async function loginRecords(): Promise<readonly SshLoginRecord[]> {
    if (!(await deps.exists(paths.sshdLog))) return []
    const parsed = parseSshLog(await deps.readText(paths.sshdLog), deps.nowIso())
    return parsed.map((line, index) => ({
      id: `login-${index + 1}`,
      ip: line.ip,
      port: line.port,
      at: loginLineAt(line),
      user: line.user,
      result: line.result,
    }))
  }

  async function passwdEntries(): Promise<readonly PasswdEntry[]> {
    const output = await deps.runGetent(['passwd']).catch((error: unknown) => {
      throw commandError('getent', ['passwd'], error)
    })
    return parseGetentPasswd(output)
  }

  /** 密钥可归属的真实账号（有登录 shell、uid≥1000、非 root），getent 只跑一次。 */
  async function keyAccountEntries(): Promise<readonly PasswdEntry[]> {
    const entries = await passwdEntries()
    return entries.filter(isKeyAccount)
  }

  /** 单个账号的 passwd 条目：主目录只从 getent 推导，绝不接受客户端传路径。 */
  async function entryOf(name: string): Promise<PasswdEntry> {
    const output = await deps.runGetent(['passwd', name]).catch((error: unknown) => {
      throw commandError('getent', ['passwd', name], error)
    })
    const entry = parseGetentPasswd(output)[0]
    if (!entry) throw new Error(`未找到系统账号：${name}`)
    return entry
  }

  async function authorizedKeysText(entry: PasswdEntry): Promise<string | null> {
    const path = authorizedKeysPath(entry.home)
    return (await deps.exists(path)) ? deps.readText(path) : null
  }

  /** 公钥行经 ssh-keygen -lf 验证并取指纹：非法行在这里被拒，永远到不了 authorized_keys。 */
  async function verifyPublicKey(keyLine: string) {
    await ensureDir(paths.keygenWorkspace)
    tempSeq += 1
    const verifyPath = `${paths.keygenWorkspace}/verify-${tempSeq}.pub`
    await deps.writeText(verifyPath, `${keyLine}\n`)
    try {
      const stdout = await deps.runSshKeygen(['-lf', verifyPath]).catch((error: unknown) => {
        throw commandError('ssh-keygen', ['-lf', verifyPath], error)
      })
      const parsed = parseKeygenFingerprint(stdout)
      if (!parsed) {
        throw new Error(`ssh-keygen 指纹输出无法解析：${stdout.trim()}`)
      }
      return parsed
    } finally {
      await deps.remove(verifyPath)
    }
  }

  /** authorized_keys 的原子写、权限收紧与属主落位：目录 0700、文件 0600，均 chown 到账号名下，写前备份。 */
  async function writeAuthorizedKeys(entry: PasswdEntry, original: string | null, next: string): Promise<void> {
    const dir = sshDirPath(entry.home)
    await ensureDir(dir)
    await deps.chmod(dir, 0o700)
    await deps.chown(dir, entry.uid, entry.gid)
    const target = authorizedKeysPath(entry.home)
    await writeAtomic(target, original, next)
    await deps.chmod(target, 0o600)
    await deps.chown(target, entry.uid, entry.gid)
  }

  function firstSeenAt(lineId: string): string {
    let at = keyFirstSeenAt.get(lineId)
    if (!at) {
      at = deps.nowIso()
      keyFirstSeenAt.set(lineId, at)
    }
    return at
  }

  /** authorized_keys 注释 → 面板密钥名：面板创建的行注释形如 elysian-<名称>，外来行按注释原样呈现。 */
  function keyNameOf(keyLine: string): string {
    const comment = keyCommentOf(keyLine)
    if (comment.startsWith(KEY_COMMENT_PREFIX)) return comment.slice(KEY_COMMENT_PREFIX.length)
    return comment || '未命名'
  }

  async function keysOfAccount(entry: PasswdEntry): Promise<readonly SshLoginKey[]> {
    const text = await authorizedKeysText(entry)
    if (text === null) return []
    const keys: SshLoginKey[] = []
    for (const line of parseKeyLines(text)) {
      const fingerprint = await verifyPublicKey(line)
      // id 含账号维度：同一公钥行装进多个账号时 id 各不相同，删除不会误删别的账号的同款行。
      const id = authorizedKeyId(entry.name, line)
      keys.push({
        id,
        name: keyNameOf(line),
        userId: entry.name,
        algorithm: algorithmLabelOf(fingerprint),
        fingerprint: fingerprint.fingerprint,
        createdAt: firstSeenAt(id),
        publicKey: line,
      })
    }
    return keys
  }

  return {
    async overview(): Promise<SshOverview> {
      // enabled 与 status 都映射 sshd 是否在跑（pidfile 探测）；
      // changedAt 只反映本会话内的启停（契约：本会话内没改过时为 null，界面显示 —）。
      const running = await serviceRunning()
      const stats = summarizeSshLog(await loginRecords(), deps.nowIso())
      return {
        enabled: running,
        status: running ? 'running' : 'stopped',
        changedAt: lastToggleAt,
        stats,
      }
    },

    async settings(): Promise<SshAuthSettings> {
      return settingsOf(await readEffectiveConfigText())
    },

    async rootAuth(): Promise<SshRootAuth> {
      const policy = policyOf(await readEffectiveConfigText())
      const root = await entryOf('root')
      const text = await authorizedKeysText(root)
      const firstLine = text === null ? undefined : parseKeyLines(text)[0]
      // root 的密钥卡取 authorized_keys 首行；没有公钥时如实为 null（尚未生成）。
      if (!firstLine) return { policy, key: null, passwordResetAt }
      const fingerprint = await verifyPublicKey(firstLine)
      return {
        policy,
        key: {
          algorithm: algorithmLabelOf(fingerprint),
          fingerprint: fingerprint.fingerprint,
          createdAt: firstSeenAt(keyLineId(firstLine)),
          publicKey: firstLine,
        },
        passwordResetAt,
      }
    },

    async setServiceEnabled(enabled: boolean): Promise<SshOverview> {
      // 启停自管：start 带 -E 保证日志源不丢，stop 对 pidfile 发 TERM；都不依赖 service 命令。
      const action = enabled ? 'startSshd' : 'stopSshd'
      await deps[action]().catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`${enabled ? '启动' : '停止'} sshd 失败：${detail}`)
      })
      if (!(await waitForServiceState(enabled))) {
        throw new Error(`${enabled ? '启动' : '停止'} sshd 未生效：服务状态未在预期时间内收敛，请稍后刷新查看实际状态`)
      }
      lastToggleAt = deps.nowIso()
      return this.overview()
    },

    async setAuthMethods(methods: SshAuthMethods): Promise<SshAuthSettings> {
      await patchAndApply({
        PasswordAuthentication: methods.passwordAuthEnabled ? 'yes' : 'no',
        PubkeyAuthentication: methods.keyAuthEnabled ? 'yes' : 'no',
      })
      return settingsOf(await readEffectiveConfigText())
    },

    async setPort(port: number): Promise<SshAuthSettings> {
      // 判据与表单共用同一函数：界面挡一次，这里再挡一次，绕过界面也写不进配置。
      if (!isValidSshPort(port)) throw new Error('SSH 端口需为 1-65535 的整数')
      await patchAndApply({ Port: `${port}` })
      return settingsOf(await readEffectiveConfigText())
    },

    async saveRootLoginPolicy(policy: SshRootLoginPolicy): Promise<SshRootAuth> {
      if (!SSH_ROOT_LOGIN_POLICIES.includes(policy)) {
        throw new Error(`无效的 Root 登录策略：${policy}`)
      }
      await patchAndApply({ PermitRootLogin: policy })
      return this.rootAuth()
    },

    async resetRootPassword(password: string): Promise<SshPasswordResetResult> {
      // chpasswd 按行解析「账号:密码」：密码含换行会变成额外的改密行（越界改掉其他账号），
      // 控制字符一律拒绝——与密钥名称共用同一条禁区判据。
      if (hasUnsafeControlChars(password)) {
        throw new Error('密码不能包含换行或控制字符')
      }
      // 服务端复验强度：界面挡一次不算数，绕过界面也改不了真实密码。
      const strength = evaluateSshPasswordStrength(password)
      if (strength === 'weak') {
        throw new Error('密码强度不足：判定为弱密码，请加长密码并混合大小写字母、数字与符号')
      }
      await deps.runChpasswd(`root:${password}`).catch((error: unknown) => {
        // 错误信息只描述命令本身：密码绝不进命令行，也不进任何日志与报错。
        throw new Error(`chpasswd 执行失败：${error instanceof Error ? error.message : String(error)}`)
      })
      passwordResetAt = deps.nowIso()
      return { auth: await this.rootAuth(), strength }
    },

    async createRootKey(): Promise<SshRootAuth> {
      const root = await entryOf('root')
      await ensureDir(paths.keygenWorkspace)
      tempSeq += 1
      const keyPath = `${paths.keygenWorkspace}/elysian-root-key-${tempSeq}`
      await deps
        .runSshKeygen(['-t', 'ed25519', '-C', `${KEY_COMMENT_PREFIX}root`, '-N', '', '-f', keyPath])
        .catch((error: unknown) => {
          throw commandError('ssh-keygen', ['-t', 'ed25519', '-C', `${KEY_COMMENT_PREFIX}root`, '-N', '', '-f', keyPath], error)
        })
      // 与登录密钥同一纪律：私钥读进内存后立即删除临时文件，此后只在本次响应里。
      let privateKey: string
      let publicKey: string
      try {
        privateKey = await deps.readText(keyPath)
        publicKey = (await deps.readText(`${keyPath}.pub`)).trim()
      } finally {
        await deps.remove(keyPath).catch(() => undefined)
        await deps.remove(`${keyPath}.pub`).catch(() => undefined)
      }

      const fingerprint = await verifyPublicKey(publicKey)
      // Root 密钥卡只管理首行：替换第一条公钥行，外来公钥行原样保留；旧私钥随之作废。
      // 读-改-写进互斥队列：与其他密钥变更并发时保持完整，后写不覆盖前写。
      await serializeKeysWrite(async () => {
        const original = await authorizedKeysText(root)
        await writeAuthorizedKeys(root, original, replaceFirstKeyLine(original ?? '', publicKey))
      })
      const createdAt = deps.nowIso()
      keyFirstSeenAt.set(keyLineId(publicKey), createdAt)
      return {
        policy: policyOf(await readEffectiveConfigText()),
        key: {
          algorithm: algorithmLabelOf(fingerprint),
          fingerprint: fingerprint.fingerprint,
          createdAt,
          publicKey,
          // 私钥仅随生成响应一次性携带：rootAuth 与列表都不再返回。
          privateKey,
        },
        passwordResetAt,
      }
    },

    async listKeys(): Promise<readonly SshLoginKey[]> {
      const accounts = await keyAccountEntries()
      const keys: SshLoginKey[] = []
      for (const entry of accounts) {
        keys.push(...(await keysOfAccount(entry)))
      }
      return keys
    },

    async listLoginRecords(): Promise<readonly SshLoginRecord[]> {
      // 日志按时间顺序解析，界面按时间倒序呈现。
      return [...(await loginRecords())].reverse()
    },

    async keyAccounts() {
      return listKeyAccounts(
        await deps.runGetent(['passwd']).catch((error: unknown) => {
          throw commandError('getent', ['passwd'], error)
        }),
      )
    },

    async createKey(input: { name: string; userId: string }): Promise<SshLoginKey> {
      const name = input.name.trim()
      if (!isValidSshKeyName(name)) {
        throw new Error(`密钥名称需为 1-${SSH_KEY_NAME_MAX_LENGTH} 个字符`)
      }
      if (hasUnsafeControlChars(input.name)) {
        throw new Error('密钥名称不能包含换行或控制字符')
      }

      /**
       * 查重、生成与落盘整体进互斥队列：并发请求排队执行，每次追加都基于最新
       * authorized_keys 计算，不会出现两个请求读同一份原文、后写覆盖前写而丢掉
       * 先返回那把密钥的公钥行（其私钥只在创建响应里一次性带出，丢了无处可取）。
       */
      return serializeKeysWrite(async () => {
        // 归属账号必须是白名单里的真实系统账号：客户端只传账号名，路径全部由服务端推导。
        const accounts = await keyAccountEntries()
        const account = accounts.find((entry) => entry.name === input.userId)
        if (!account) throw new Error(`归属账号不存在：${input.userId}`)

        const existing = await this.listKeys()
        if (existing.some((key) => key.name === name)) {
          throw new Error(`密钥名称已存在：${name}`)
        }

        await ensureDir(paths.keygenWorkspace)
        tempSeq += 1
        const keyPath = `${paths.keygenWorkspace}/elysian-key-${tempSeq}`
        await deps
          .runSshKeygen(['-t', 'ed25519', '-C', `${KEY_COMMENT_PREFIX}${name}`, '-N', '', '-f', keyPath])
          .catch((error: unknown) => {
            throw commandError('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', keyPath], error)
          })
        // 私钥读进内存后立即删除临时文件；此后私钥只在本次响应里，任何地方都不再落盘。
        let privateKey: string
        let publicKey: string
        try {
          privateKey = await deps.readText(keyPath)
          publicKey = (await deps.readText(`${keyPath}.pub`)).trim()
        } finally {
          await deps.remove(keyPath).catch(() => undefined)
          await deps.remove(`${keyPath}.pub`).catch(() => undefined)
        }

        const fingerprint = await verifyPublicKey(publicKey)
        const original = await authorizedKeysText(account)
        await writeAuthorizedKeys(account, original, appendKeyLine(original ?? '', publicKey))

        const id = authorizedKeyId(account.name, publicKey)
        const createdAt = deps.nowIso()
        keyFirstSeenAt.set(id, createdAt)
        return {
          id,
          name,
          userId: account.name,
          algorithm: algorithmLabelOf(fingerprint),
          fingerprint: fingerprint.fingerprint,
          createdAt,
          publicKey,
          // 私钥仅随创建响应一次性携带：列表与查看都不再返回。
          privateKey,
        }
      })
    },

    async removeKey(keyId: string): Promise<void> {
      // 进互斥队列：与创建并发时同样保持读-改-写完整。
      return serializeKeysWrite(async () => {
        const accounts = await keyAccountEntries()
        for (const entry of accounts) {
          const text = await authorizedKeysText(entry)
          if (text === null) continue
          // id 含账号维度：只撤销目标账号里的那一行，其他账号的同款公钥不受影响。
          const target = parseKeyLines(text).find((line) => authorizedKeyId(entry.name, line) === keyId)
          if (!target) continue
          await writeAuthorizedKeys(entry, text, removeKeyLine(text, target))
          return
        }
        throw new Error(`未找到登录密钥 ${keyId}`)
      })
    },
  }
}
