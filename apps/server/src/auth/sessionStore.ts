import { constants } from 'node:fs'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { randomUUID, randomBytes } from 'node:crypto'
import { dirname } from 'node:path'
import { ELYSIAN_PATHS } from '../shared/elysianPaths.ts'
import { SESSION_ABSOLUTE_TTL_MS, SESSION_IDLE_TTL_MS } from './authConfig.ts'

/*
 * 服务端会话存储：~/.Elysian/state/panel-sessions.json（0600、临时文件 + 原子 rename）。
 *
 * 会话是服务端事实，Cookie 只承载不透明 id（32 字节随机数的 base64url，256-bit）。
 * 文件持久化的理由：dev 下 server 以 bun --watch 运行，每次改码重启进程，会话只存
 * 内存会让开发全程反复掉线。CLI 不触碰会话文件（只写凭据文件），无跨进程写竞争。
 *
 * 生命周期（全部服务端权威）：
 * - 空闲 12 小时：validate 时 now - lastUsedAt 超时即删除并回 null；未超时则滑动更新。
 * - 绝对上限 7 天：now - createdAt 超时即删除，无论活跃。
 * - epoch 失效：会话记录的 pwdEpoch 与当前凭据的 passwordChangedAt 不一致（CLI 已
 *   改密、凭据文件被删或重建）即删除——改密后全部既有会话在下一次请求时 401。
 * - 惰性清扫：任一 validate 顺带剔除已过期会话；单用户场景会话数个位数，无需定时器。
 *
 * 落盘时机：create 与 destroy 立即写文件；lastUsedAt 滑动只改内存，随下一次
 * create/destroy 顺带落盘（进程崩溃最多让某会话的空闲窗口被低估，无害）。
 *
 * 边界如实记录：鉴权只发生在请求与升级的边界。登出、改密（epoch 轮换）、退出其他
 * 会话三条显式失效路径经会话连接撤销表（sessionConnections.ts）立即关闭已登记的
 * 终端连接；会话空闲/绝对过期与 CLI resetpwd（跨进程改凭据文件，无进程内触发点）
 * 下已建立连接存活至自然断开，且空闲回收对主动保活的客户端不构成回收——任意客户
 * 端帧（含协议内置 ping）都会重置空闲计时，持续打 ping 的终端事实上无界存活。新
 * 连接与新请求在失效后一律 401。
 */

export type PanelSession = {
  id: string
  createdAt: number
  lastUsedAt: number
  pwdEpoch: string
}

export interface SessionStore {
  create(pwdEpoch: string): Promise<PanelSession>
  /** 校验并滑动续期；会话不存在、过期或 epoch 不匹配时删除并回 null。 */
  validate(sessionId: string, pwdEpoch: string): Promise<PanelSession | null>
  destroy(sessionId: string): Promise<void>
  /** 只读列举未过期会话：过期会话就地过滤、不落盘（清扫仍由 validate 顺带完成）。 */
  list(): Promise<readonly PanelSession[]>
  /** 销毁除 keepSessionId 外的全部会话，立即落盘。 */
  destroyOthers(keepSessionId: string): Promise<void>
}

const SESSIONS_PATH = ELYSIAN_PATHS.panelSessions
const SESSIONS_MAX_BYTES = 1024 * 1024

type SessionFile = { version: 1; sessions: PanelSession[] }

function newSessionId(): string {
  return randomBytes(32).toString('base64url')
}

function isExpired(session: PanelSession, now: number): boolean {
  return now - session.lastUsedAt > SESSION_IDLE_TTL_MS || now - session.createdAt > SESSION_ABSOLUTE_TTL_MS
}

/** 读会话文件；缺失、损坏、权限异常一律回空表（fail closed：全部会话失效）。 */
async function readSessions(path: string): Promise<PanelSession[]> {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ELOOP') return []
    throw error
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > SESSIONS_MAX_BYTES || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) return []
    const parsed: unknown = JSON.parse(await handle.readFile({ encoding: 'utf8' }))
    if (typeof parsed !== 'object' || parsed === null) return []
    const sessions = (parsed as Record<string, unknown>)['sessions']
    if (!Array.isArray(sessions)) return []
    return sessions.filter((session): session is PanelSession => {
      if (typeof session !== 'object' || session === null) return false
      const record = session as Record<string, unknown>
      return typeof record['id'] === 'string' && typeof record['createdAt'] === 'number' && typeof record['lastUsedAt'] === 'number' && typeof record['pwdEpoch'] === 'string'
    })
  } catch {
    return []
  } finally {
    await handle.close()
  }
}

/** 原子写会话文件（0600 临时文件 + fsync + rename）。 */
async function writeSessions(path: string, sessions: readonly PanelSession[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const file: SessionFile = { version: 1, sessions: [...sessions] }
  const temporary = `${path}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify(file, null, 2))
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
}

export type SessionStoreOptions = {
  /** 可控时钟：测试注入；缺省 Date.now()。 */
  now?: () => number
}

export function createFileSessionStore(path: string = SESSIONS_PATH, options: SessionStoreOptions = {}): SessionStore {
  const now = options.now ?? Date.now
  // 写串行队列：destroy 的删除与 create 的追加不交错（照 registry 先例）。
  let tail: Promise<unknown> = Promise.resolve()
  // 内存镜像：lastUsedAt 滑动只改这里，随下一次落盘顺带写出。
  let cached: readonly PanelSession[] | undefined

  async function load(): Promise<readonly PanelSession[]> {
    if (cached === undefined) cached = await readSessions(path)
    return cached
  }

  function persist(next: readonly PanelSession[]): Promise<void> {
    cached = next
    const run = tail.then(() => writeSessions(path, next))
    tail = run.catch(() => undefined)
    return run
  }

  return {
    async create(pwdEpoch: string): Promise<PanelSession> {
      const sessions = [...(await load())]
      const session: PanelSession = { id: newSessionId(), createdAt: now(), lastUsedAt: now(), pwdEpoch }
      sessions.push(session)
      await persist(sessions)
      return { ...session }
    },

    async validate(sessionId: string, pwdEpoch: string): Promise<PanelSession | null> {
      const at = now()
      const sessions = [...(await load())]
      // 惰性清扫：先剔除全部过期会话（含被查的这个），被查者不在幸存集合里即回 null。
      const survivors = sessions.filter((session) => !isExpired(session, at))
      const swept = survivors.length !== sessions.length
      const target = survivors.find((session) => session.id === sessionId)
      if (target === undefined) {
        // 有实际删除（含被查会话本身过期）才落盘；纯未命中不写文件。
        if (swept) await persist(survivors)
        return null
      }
      if (target.pwdEpoch !== pwdEpoch) {
        await persist(survivors.filter((session) => session.id !== sessionId))
        return null
      }
      const slid = { ...target, lastUsedAt: at }
      const next = survivors.map((session) => (session.id === slid.id ? slid : session))
      // 滑动只改内存：无删除发生时不写文件（设计决定），随下一次 create/destroy 落盘。
      if (swept) await persist(next)
      else cached = next
      return { ...slid }
    },

    async destroy(sessionId: string): Promise<void> {
      const sessions = [...(await load())]
      if (!sessions.some((session) => session.id === sessionId)) return
      await persist(sessions.filter((session) => session.id !== sessionId))
    },

    async list(): Promise<readonly PanelSession[]> {
      const at = now()
      // 只读视图：过滤过期但不落盘——读端点无副作用，磁盘上的清扫仍由 validate 顺带完成。
      return (await load()).filter((session) => !isExpired(session, at)).map((session) => ({ ...session }))
    },

    async destroyOthers(keepSessionId: string): Promise<void> {
      const sessions = [...(await load())]
      const next = sessions.filter((session) => session.id === keepSessionId)
      // 没有其他会话时不写文件（与 destroy 的无用写规避同纪律）；有销毁则立即落盘。
      if (next.length === sessions.length) return
      await persist(next)
    },
  }
}

/** 内存版会话存储：测试用，不碰文件系统，语义与文件版一致。 */
export function createMemorySessionStore(options: SessionStoreOptions = {}): SessionStore {
  const now = options.now ?? Date.now
  let sessions: PanelSession[] = []
  return {
    async create(pwdEpoch: string) {
      const session: PanelSession = { id: newSessionId(), createdAt: now(), lastUsedAt: now(), pwdEpoch }
      sessions = [...sessions, session]
      return { ...session }
    },
    async validate(sessionId: string, pwdEpoch: string) {
      const at = now()
      const survivors = sessions.filter((session) => !isExpired(session, at))
      sessions = survivors
      const target = survivors.find((session) => session.id === sessionId)
      if (target === undefined) return null
      if (target.pwdEpoch !== pwdEpoch) {
        sessions = survivors.filter((session) => session.id !== sessionId)
        return null
      }
      const slid = { ...target, lastUsedAt: at }
      sessions = survivors.map((session) => (session.id === slid.id ? slid : session))
      return { ...slid }
    },
    async destroy(sessionId: string) {
      sessions = sessions.filter((session) => session.id !== sessionId)
    },
    async list() {
      const at = now()
      return sessions.filter((session) => !isExpired(session, at)).map((session) => ({ ...session }))
    },
    async destroyOthers(keepSessionId: string) {
      sessions = sessions.filter((session) => session.id === keepSessionId)
    },
  }
}
