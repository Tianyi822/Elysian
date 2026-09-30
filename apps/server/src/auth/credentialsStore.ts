import { constants } from 'node:fs'
import { open, rename, unlink, mkdir } from 'node:fs/promises'
import { randomBytes, randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { ELYSIAN_PATHS } from '../shared/elysianPaths.ts'
import { AUTH_DEV_WARNING, INITIAL_PASSWORD_CHARSET, INITIAL_PASSWORD_LENGTH, PANEL_USERNAME } from './authConfig.ts'
import { createScryptHasher, type PasswordHasher } from './passwordHasher.ts'

/*
 * 面板登录凭据（单用户 admin）：~/.Elysian/config/panel-credentials.json。
 *
 * current() **每次直读文件、不缓存**（设计决定，放弃 mtime 缓存）：秒粒度文件系统上
 * 同秒改密会让 mtime 缓存漏感知，凭据 JSON 各字段近似定长、size 辅助判定也失效；
 * 直读让 CLI 改密落盘后 server **下一次请求必然**看到新 passwordChangedAt，既有
 * 会话随之全量失效，无任何时间窗口。成本是一个不足 200 字节的 JSON，回环单用户
 * 每请求至多读一次。
 *
 * 解析失败（坏 JSON、缺字段、版本不符、权限被放宽）一律回 null——fail closed：
 * 登录恒拒绝、既有会话恒失效。读写纪律照 databaseRegistry 先例：O_NOFOLLOW 读 +
 * 权限/属主/大小校验，0600 临时文件 + fsync + rename 原子写。
 */

export type PanelCredentials = {
  username: string
  passwordHash: string
  /** ISO 时间戳；会话失效的 epoch 基准。 */
  passwordChangedAt: string
}

export interface CredentialsStore {
  /** 读当前凭据；文件缺失回 null。每次调用直读文件并解析，不做任何缓存。 */
  current(): Promise<PanelCredentials | null>
  /** 原子写入新哈希并返回含新 passwordChangedAt 的完整凭据。 */
  write(passwordHash: string): Promise<PanelCredentials>
}

const CREDENTIALS_PATH = ELYSIAN_PATHS.panelCredentials
const CREDENTIALS_MAX_BYTES = 64 * 1024

/** 判定解析出的 JSON 是否是合法凭据；版本与三字段缺一不可。 */
function isPanelCredentials(value: unknown): value is PanelCredentials {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    record['version'] === 1 &&
    typeof record['username'] === 'string' &&
    typeof record['passwordHash'] === 'string' &&
    typeof record['passwordChangedAt'] === 'string'
  )
}

export function createFileCredentialsStore(path: string = CREDENTIALS_PATH): CredentialsStore {
  return {
    async current(): Promise<PanelCredentials | null> {
      let handle
      try {
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        // 文件不存在与读不了（含最终组件是符号链接被 O_NOFOLLOW 拒绝）都视为「凭据不可用」。
        if (code === 'ENOENT' || code === 'ELOOP') return null
        throw error
      }
      try {
        const stat = await handle.stat()
        if (!stat.isFile() || stat.size > CREDENTIALS_MAX_BYTES || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) return null
        const parsed: unknown = JSON.parse(await handle.readFile({ encoding: 'utf8' }))
        return isPanelCredentials(parsed) ? { username: parsed.username, passwordHash: parsed.passwordHash, passwordChangedAt: parsed.passwordChangedAt } : null
      } catch {
        // 坏 JSON、读失败：fail closed，不向调用方抛（登录/会话判定按「无凭据」处理）。
        return null
      } finally {
        await handle.close()
      }
    },

    async write(passwordHash: string): Promise<PanelCredentials> {
      const credentials: PanelCredentials = {
        username: PANEL_USERNAME,
        passwordHash,
        passwordChangedAt: new Date().toISOString(),
      }
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      const temporary = `${path}.${randomUUID()}.tmp`
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify({ version: 1, ...credentials }, null, 2))
        await handle.sync()
      } finally {
        await handle.close()
      }
      try {
        await rename(temporary, path)
      } catch (error) {
        await unlink(temporary).catch(() => undefined)
        throw error
      }
      return credentials
    },
  }
}

/** 内存版凭据 store：测试用，不碰文件系统。 */
export function createMemoryCredentialsStore(initial?: PanelCredentials): CredentialsStore {
  let current: PanelCredentials | null = initial === undefined ? null : { ...initial }
  return {
    async current() {
      return current === null ? null : { ...current }
    },
    async write(passwordHash: string) {
      current = { username: PANEL_USERNAME, passwordHash, passwordChangedAt: new Date().toISOString() }
      return { ...current }
    },
  }
}

/** 拒绝采样生成初始密码：字节落在 charset.length 的整数倍区间外即弃用，分布无偏。 */
export function generateInitialPassword(length: number = INITIAL_PASSWORD_LENGTH): string {
  const limit = Math.floor(256 / INITIAL_PASSWORD_CHARSET.length) * INITIAL_PASSWORD_CHARSET.length
  let password = ''
  while (password.length < length) {
    const bytes = randomBytes(length * 2)
    for (const byte of bytes) {
      if (byte >= limit) continue
      password += INITIAL_PASSWORD_CHARSET[byte % INITIAL_PASSWORD_CHARSET.length]
      if (password.length === length) break
    }
  }
  return password
}

export type FirstBootOutcome = 'dev-skipped' | 'already-present' | 'created'

/**
 * 首启保障（装配层副作用，createApp 不碰）：
 * - dev 开 → 只打警告行（AUTH_DEV_WARNING），不生成文件；
 * - 凭据文件已存在 → 直接返回；
 * - 否则生成 16 字符随机密码（无歧义字符集），scrypt 落盘后向 stdout 打一次性横幅。
 * 初始密码只显示这一次、不落任何日志文件；横幅经注入的 print（缺省 console.log）。
 */
export async function ensureFirstBootCredentials(
  store: CredentialsStore,
  options: { dev: boolean; hasher?: PasswordHasher; generatePassword?: () => string; print?: (line: string) => void },
): Promise<FirstBootOutcome> {
  const print = options.print ?? ((line: string) => console.log(line))
  if (options.dev) {
    print(AUTH_DEV_WARNING)
    return 'dev-skipped'
  }
  if ((await store.current()) !== null) return 'already-present'

  const hasher = options.hasher ?? createScryptHasher()
  const password = (options.generatePassword ?? generateInitialPassword)()
  await store.write(await hasher.hash(password))
  print('==================================================')
  print('Elysian 面板已生成初始管理员账号')
  print(`用户名：${PANEL_USERNAME}`)
  print(`初始密码：${password}`)
  print('密码只显示这一次，请立即登录并妥善保管。')
  print('修改密码：docker compose exec web bun run resetpwd')
  print('==================================================')
  return 'created'
}
