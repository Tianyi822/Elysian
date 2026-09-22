import type {
  SshAdapter,
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
import { invalidRequest } from '../shared/errors.ts'
import { ELYSIAN_PATHS } from '../shared/elysianPaths.ts'
import { hasUnsafeControlChars } from '../shared/noteValidation.ts'
import { normalizeEqualsSeparator, parseSshdConfig, stripConfigComment, type SshdDirectiveName } from './parseSshdConfig.ts'
import { patchSshdConfig } from './patchSshdConfig.ts'
import { parseSshLog, summarizeSshLog } from './parseSshLog.ts'
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
} from '../shared/authorizedKeys.ts'

/*
 * SSH 面板的服务编排：把界面动作翻译成容器内 sshd / ssh-keygen / chpasswd 的真实执行。
 * 全部系统访问经 deps 注入，编排逻辑在 Vitest 里用有状态 fake（内存文件与命令账本）驱动。
 *
 * 安全红线：
 * - 所有命令经注入的 execFile 数组传参执行，绝不拼 shell 字符串；密钥名称与 Root 密码
 *   都拒绝换行与控制字符（密码按行进 chpasswd 的 stdin，含换行会越界改掉其他账号）。
 * - sshd_config 只补丁四个白名单指令，写前备份、临时文件加 rename 原子落盘，
 *   `sshd -t` 预检失败立即回滚原配置——回滚同样走原子写；补丁全程进串行队列，
 *   并发请求排队落盘，后写不覆盖先写。重载（SIGHUP）后短轮询复查服务存活，
 *   进程退出（如端口被占用）立即用原文原子回滚并如实报错。
 *   补丁与读取都对齐 Include 语义：面板行插到 Include 之前保证 first-obtained 生效，
 *   读取时展开 sshd_config.d 后按 sshd 取值顺序呈现生效值；Port 为累积监听指令，
 *   替换首个 Port 行的同时注释掉其余未注释 Port 行。
 * - 服务在跑与否以 pidfile 加进程身份双核实：读 /proc/<pid>/comm 确认是 sshd 才算，
 *   pid 被无关进程复用时按未运行处理，停止信号只发给核实过身份的进程。
 * - authorized_keys 行级编辑：公钥行经 ssh-keygen -lf 验证后追加/删除，.ssh 0700、文件 0600；
 *   行 id 含账号维度，同一公钥装多账号时按 id 删除只撤销目标账号；全部读-改-写进互斥队列，
 *   并发请求排队落盘，后写不覆盖前写。列表对无法验证的脏行只跳过并计数，不整体报错。
 * - Root 密码只走 chpasswd 的 stdin，不进命令行参数。
 * - 私钥只在创建/生成响应里一次性带出：生成后立即读出并删除临时密钥文件，之后无处可取。
 */

export const DEFAULT_SSH_PATHS = {
  sshdConfig: '/etc/ssh/sshd_config',
  sshdLog: ELYSIAN_PATHS.sshdLog,
  sshdPidFile: '/run/sshd.pid',
  /** ssh-keygen 的工作目录：密钥对在这里生成、验完即删，不进任何用户主目录。 */
  keygenWorkspace: ELYSIAN_PATHS.keygenWorkspace,
  /**
   * 上次启停时间戳：sshd 自身不记启停，落在部署机器的 `~/.Elysian/state`（容器内经符号链接到持久卷），
   * 进程重启与页面刷新后仍能读到；不是浏览器 localStorage。
   */
  changedAtStamp: ELYSIAN_PATHS.sshChangedAt,
  /** Root 密码上次重置时间戳：chpasswd 不留可读记录，同样由面板落在命名卷上。 */
  passwordResetAtStamp: ELYSIAN_PATHS.sshRootPasswordResetAt,
}

/**
 * 登录日志按字节取尾的预算：远大于 2000 行常规行宽的总量（SSH_LOG_TAIL_LINES 上限），
 * 超预算的旧段不再读进内存——截尾发生在读取层而不是整读之后。
 */
export const SSH_LOG_TAIL_BYTES = 512 * 1024

export type SshHostDeps = {
  /** 执行 ssh-keygen 子命令，返回 stdout；失败抛错（含 stderr）。 */
  runSshKeygen(args: readonly string[]): Promise<string>
  /** 执行 sshd（如 `sshd -t` 配置预检），返回 stdout。 */
  runSshd(args: readonly string[]): Promise<string>
  /**
   * 以容器既定参数启动 sshd（daemonize，自行写 pidfile）：`sshd -E <日志路径>`。
   * 不走 service ssh start——容器里 /etc/default/ssh 的 SSHD_OPTS 为空，
   * 那样启动出的 sshd 不写 ~/.Elysian/logs/sshd.log，面板日志源随之冻结。
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
  /**
   * 只读文件末段（最多 maxBytes 字节）：登录日志按尾读取，大文件不整读进堆；
   * 从文件中部起读（发生截断）时，返回文本已丢弃不完整的首行。
   */
  readTextTail(path: string, maxBytes: number): Promise<string>
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

/**
 * 登录密钥列表的附带报告：authorized_keys 里无法验证的脏行只跳过并计数。
 * 计数随 HTTP 响应带出（契约先留接口，界面暂不渲染），列表本身永不因单行失败整体失败。
 */
export type SshListKeysReport = {
  keys: readonly SshLoginKey[]
  /** 各账号 authorized_keys 里被跳过的无效行数合计。 */
  ignoredInvalidLines: number
}

export function createSshService(deps: SshHostDeps): SshAdapter & {
  /** 列表附带脏行计数（GET /keys 响应带出）；SshAdapter 契约方法保持不变。 */
  listKeysWithReport(): Promise<SshListKeysReport>
} {
  const paths = deps.paths ?? DEFAULT_SSH_PATHS
  /** 公钥行 id → 本次会话首次观察到的时间：authorized_keys 无时间戳，创建时间是会话记忆。 */
  const keyFirstSeenAt = new Map<string, string>()
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

  /**
   * sshd_config 读-改-写的互斥队列：并发的配置补丁排队执行，每次补丁都基于最新
   * 落盘原文计算——两个请求各拿旧原文覆写会让先落盘的改动静默丢失且双方都报成功
   * （与 authorized_keys 的互斥队列同一纪律）。
   */
  let configWriteTail: Promise<unknown> = Promise.resolve()
  function serializeConfigWrite<T>(critical: () => Promise<T>): Promise<T> {
    const run = configWriteTail.then(critical, critical)
    configWriteTail = run.then(
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

  /**
   * 时间戳文件的读写：sshd 自身不记录的事实（启停、Root 密码重置）由面板自己落盘，
   * 落在部署机器的 `~/.Elysian/state`（容器内经符号链接到持久卷），进程重启与页面刷新后仍能读到；不是浏览器 localStorage。
   */
  async function readStamp(path: string): Promise<string | null> {
    if (!(await deps.exists(path))) return null
    try {
      const text = (await deps.readText(path)).trim()
      return text || null
    } catch {
      return null
    }
  }

  async function writeStamp(path: string, iso: string): Promise<void> {
    const slash = path.lastIndexOf('/')
    if (slash > 0) await ensureDir(path.slice(0, slash))
    await deps.writeText(path, iso)
  }

  async function serviceRunning(): Promise<boolean> {
    // pidfile 存在只是线索：pid 可能已被无关进程复用。读 /proc/<pid>/comm 核实身份
    // 后才算在跑；pidfile 读不出、pid 非法或 comm 读不到（进程已退）都按未运行处理。
    let pidText: string
    try {
      pidText = await deps.readText(paths.sshdPidFile)
    } catch {
      return false
    }
    const pid = Number.parseInt(pidText.trim(), 10)
    if (!Number.isInteger(pid)) return false
    let comm: string
    try {
      comm = await deps.readText(`/proc/${pid}/comm`)
    } catch {
      return false
    }
    return comm.trim() === 'sshd'
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

  /**
   * SIGHUP 重载后确认 sshd 存活：重载触发 re-exec 重读配置，端口被占用这类只在
   * 真实监听时暴露的致命问题会让进程直接退出并清掉 pidfile。短轮询一个窗口，
   * 期间任何一次探测发现不在跑即判定死亡，交由调用方回滚原文。
   */
  async function serviceAliveAfterReload(): Promise<boolean> {
    const attempts = 10
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (!(await serviceRunning())) return false
      await deps.delay(100)
    }
    return serviceRunning()
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
   * Include 的 Keyword=Value 等号写法与空白写法等价（sshd_config(5)），关键词识别前
   * 先行归一；递归深度设上限，防止 drop-in 互相 Include 成环时读挂面板。
   */
  async function expandIncludes(text: string, depth: number): Promise<string> {
    if (depth >= 16) return ''
    const out: string[] = []
    for (const rawLine of text.split('\n')) {
      const line = normalizeEqualsSeparator(stripConfigComment(rawLine).trim())
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
   * 全程进串行队列：并发的补丁排队执行，后写者基于最新原文计算，不静默丢掉先写者的改动。
   * 预检失败立即用原文原子回滚并抛中文错误；重载后复查服务存活，进程退出（如端口被
   * 占用）同样原子回滚并如实报错；未改动时直接返回，不产生任何写与重载。
   * 重载用 SIGHUP 而不是 service restart：sshd re-exec 时保留原启动参数（含 -E 日志路径），
   * restart 出的 sshd 会丢 -E，面板日志源随之冻结。
   */
  async function patchAndApply(patch: Partial<Record<SshdDirectiveName, string>>): Promise<void> {
    return serializeConfigWrite(async () => {
      const original = await readConfigText()
      const next = patchSshdConfig(original, patch)
      if (next === original) return

      await writeAtomic(paths.sshdConfig, original, next)
      try {
        await deps.runSshd(['-t', '-f', paths.sshdConfig]).catch((error: unknown) => {
          throw commandError('sshd', ['-t', '-f', paths.sshdConfig], error)
        })
      } catch (error) {
        // 回滚同样走原子写（.bak 已是原文，不再重复备份）：目标路径任何时刻都是完整文件。
        await writeAtomic(paths.sshdConfig, null, original)
        const detail = error instanceof Error ? error.message : String(error)
        // 预检不通过说明请求写入的取值 sshd 不接受：按请求被拒（400）返回，而不是服务端故障。
        throw invalidRequest(`sshd 配置预检未通过，已回滚原配置：${detail}`)
      }

      if (await serviceRunning()) {
        try {
          await deps.reloadSshd()
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          throw new Error(`配置已写入并通过预检，但重载 sshd 失败：${detail}`)
        }
        if (!(await serviceAliveAfterReload())) {
          // 新取值通过语法预检但进程没能活下来：用原文原子回滚并如实报错——
          // 不能让面板报成功而服务已死。
          await writeAtomic(paths.sshdConfig, null, original)
          const changed = Object.entries(patch)
            .map(([name, value]) => `${name}=${value}`)
            .join('、')
          throw new Error(
            `配置已写入并通过预检，但重载后 sshd 进程退出（本次修改：${changed}）。已回滚为原配置，服务现在处于停止状态需手动重新启用；新取值可能只在真实监听时暴露问题（如端口已被占用），请排查后重试`,
          )
        }
      }
    })
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
    // 只读尾部：超预算的旧段不进内存（截尾在读取层完成），截断出的不完整首行由 readTextTail 丢弃。
    const text = await deps.readTextTail(paths.sshdLog, SSH_LOG_TAIL_BYTES)
    const parsed = parseSshLog(text, deps.nowIso())
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
    if (!entry) throw invalidRequest(`未找到系统账号：${name}`)
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

  /** 单账号的密钥清单附带报告：无法验证的 authorized_keys 行只跳过并计数，不抛错。 */
  async function keysOfAccount(entry: PasswdEntry): Promise<SshListKeysReport> {
    const text = await authorizedKeysText(entry)
    if (text === null) return { keys: [], ignoredInvalidLines: 0 }
    const keys: SshLoginKey[] = []
    let ignoredInvalidLines = 0
    for (const line of parseKeyLines(text)) {
      // 一条脏行（如手工粘坏的外来公钥）不该拖垮整个列表，也不该连累密钥创建入口：
      // 验证失败的行跳过并计数，计数随列表报告带出。
      const fingerprint = await verifyPublicKey(line).catch(() => null)
      if (!fingerprint) {
        ignoredInvalidLines += 1
        continue
      }
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
    return { keys, ignoredInvalidLines }
  }

  return {
    async overview(): Promise<SshOverview> {
      // enabled 与 status 都映射 sshd 是否在跑（pidfile 探测）；
      // changedAt 取宿主时间戳文件：从未由面板启停过为 null（界面显示 —）。
      const running = await serviceRunning()
      const stats = summarizeSshLog(await loginRecords(), deps.nowIso())
      return {
        enabled: running,
        status: running ? 'running' : 'stopped',
        changedAt: await readStamp(paths.changedAtStamp),
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
      // 密码重置时间读宿主时间戳文件：chpasswd 不留可读记录，进程重启后仍能读到。
      const passwordResetAt = await readStamp(paths.passwordResetAtStamp)
      // Root 密钥卡取首个能通过验证的公钥行（sshd 本就忽略无法解析的行）：
      // authorized_keys 里有脏行时面板不整体报错；没有任何可验证行时如实为 null（尚未生成）。
      for (const line of text === null ? [] : parseKeyLines(text)) {
        const fingerprint = await verifyPublicKey(line).catch(() => null)
        if (!fingerprint) continue
        return {
          policy,
          key: {
            algorithm: algorithmLabelOf(fingerprint),
            fingerprint: fingerprint.fingerprint,
            createdAt: firstSeenAt(keyLineId(line)),
            publicKey: line,
          },
          passwordResetAt,
        }
      }
      return { policy, key: null, passwordResetAt }
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
      await writeStamp(paths.changedAtStamp, deps.nowIso())
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
      if (!isValidSshPort(port)) throw invalidRequest('SSH 端口需为 1-65535 的整数')
      await patchAndApply({ Port: `${port}` })
      return settingsOf(await readEffectiveConfigText())
    },

    async saveRootLoginPolicy(policy: SshRootLoginPolicy): Promise<SshRootAuth> {
      if (!SSH_ROOT_LOGIN_POLICIES.includes(policy)) {
        throw invalidRequest(`无效的 Root 登录策略：${policy}`)
      }
      await patchAndApply({ PermitRootLogin: policy })
      return this.rootAuth()
    },

    async resetRootPassword(password: string): Promise<SshPasswordResetResult> {
      // chpasswd 按行解析「账号:密码」：密码含换行会变成额外的改密行（越界改掉其他账号），
      // 控制字符一律拒绝——与密钥名称共用同一条禁区判据。
      if (hasUnsafeControlChars(password)) {
        throw invalidRequest('密码不能包含换行或控制字符')
      }
      // 服务端复验强度：界面挡一次不算数，绕过界面也改不了真实密码。
      const strength = evaluateSshPasswordStrength(password)
      if (strength === 'weak') {
        throw invalidRequest('密码强度不足：判定为弱密码，请加长密码并混合大小写字母、数字与符号')
      }
      await deps.runChpasswd(`root:${password}`).catch((error: unknown) => {
        // 错误信息只描述命令本身：密码绝不进命令行，也不进任何日志与报错。
        throw new Error(`chpasswd 执行失败：${error instanceof Error ? error.message : String(error)}`)
      })
      await writeStamp(paths.passwordResetAtStamp, deps.nowIso())
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
        passwordResetAt: await readStamp(paths.passwordResetAtStamp),
      }
    },

    async listKeysWithReport(): Promise<SshListKeysReport> {
      const accounts = await keyAccountEntries()
      const keys: SshLoginKey[] = []
      let ignoredInvalidLines = 0
      for (const entry of accounts) {
        const report = await keysOfAccount(entry)
        keys.push(...report.keys)
        ignoredInvalidLines += report.ignoredInvalidLines
      }
      return { keys, ignoredInvalidLines }
    },

    async listKeys(): Promise<readonly SshLoginKey[]> {
      return (await this.listKeysWithReport()).keys
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
        throw invalidRequest(`密钥名称需为 1-${SSH_KEY_NAME_MAX_LENGTH} 个字符`)
      }
      if (hasUnsafeControlChars(input.name)) {
        throw invalidRequest('密钥名称不能包含换行或控制字符')
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
        if (!account) throw invalidRequest(`归属账号不存在：${input.userId}`)

        const existing = await this.listKeys()
        if (existing.some((key) => key.name === name)) {
          throw invalidRequest(`密钥名称已存在：${name}`)
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
        throw invalidRequest(`未找到登录密钥 ${keyId}`)
      })
    },
  }
}
