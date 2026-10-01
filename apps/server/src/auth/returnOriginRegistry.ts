import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { ALLOWED_HOSTNAMES } from '../shared/allowedHostnames.ts'
import { ELYSIAN_PATHS } from '../shared/elysianPaths.ts'
import { RETURN_ORIGINS_MAX_BYTES, SSO_ORIGIN_IGNORED, SSO_ORIGINS_UNAVAILABLE } from './authConfig.ts'

/*
 * 单点登录的回跳白名单：~/.Elysian/config/sso-return-origins.json，用户手写、面板只读。
 *
 * 不可用一律退化为空表（不开放跳转），绝不抛错拖垮登录与探测：缺文件、坏 JSON、顶层非
 * 对象、缺 origins、非数组、version 不为 1、体积超限、路径不是文件，都只让诊断落一行
 * stderr。单项不合法只丢该项——一条笔误不该废掉全部已登记的工具。
 *
 * 每次直读不缓存（与 credentialsStore.current 同纪律）：改文件即生效，无需重启、无时间窗口。
 * 读取不校验权限位与属主：内容只是本机 origin 列表，不是秘密，加检查只换来「面板能用与不能用」
 * 的无谓差异。O_NOFOLLOW 仍保留：最终组件是符号链接时按不可用处理，不让白名单指到任意文件。
 */

const REGISTRY_PATH = ELYSIAN_PATHS.ssoReturnOrigins

export interface ReturnOriginRegistry {
  /**
   * 当前允许回跳的 origin；不可用时恒回空表。每次调用直读文件，不做任何缓存。
   * 可能 reject：超出 fail-closed 集合的 errno（EACCES/EMFILE/EIO 等）与 close 故障会原样上抛，调用方必须退化为「白名单不可用」处理。
   */
  list(): Promise<readonly string[]>
}

/** 单项合法 = 纯 origin 形式：可解析、协议 http/https、host 在回环名单、与归一后的 origin 逐字相等。 */
function normalizeOrigin(entry: unknown): string | null {
  if (typeof entry !== 'string') return null
  let url: URL
  try {
    url = new URL(entry)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (!ALLOWED_HOSTNAMES.includes(url.hostname)) return null
  // 与归一后的 origin 相等，等价于「不带 path、不带尾斜杠、已小写」——默认端口被 URL 归一吞掉时
  // （`http://127.0.0.1:80` → `http://127.0.0.1`）该项也被丢弃，因为它在裁决处永远匹配不上。
  return url.origin === entry ? entry : null
}

/**
 * 从任意抛值安全提取诊断归因：优先 errno code，其次非空 message（字符串抛值本身也算），
 * 都拿不到回「未知错误」。对 null 等非对象抛值只做 typeof 判断后取属性，绝不二次抛错
 * 把退化本身变成 reject。导出供 authRoutes 的白名单退化诊断复用，保证归因口径一致。
 */
export function errorReason(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const { code, message } = error as { code?: unknown; message?: unknown }
    if (typeof code === 'string' && code.length > 0) return code
    if (typeof message === 'string' && message.length > 0) return message
    return '未知错误'
  }
  if (typeof error === 'string' && error.length > 0) return error
  return '未知错误'
}

function unavailable(reason: string): readonly string[] {
  console.error(`${SSO_ORIGINS_UNAVAILABLE}：${reason}`)
  return []
}

function parseOrigins(text: string): readonly string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return unavailable('JSON 无法解析')
  }
  if (typeof parsed !== 'object' || parsed === null) return unavailable('顶层不是对象')
  const record = parsed as Record<string, unknown>
  if (record['version'] !== 1) return unavailable('version 不为 1')
  const origins = record['origins']
  if (!Array.isArray(origins)) return unavailable('origins 不是数组')
  const accepted: string[] = []
  for (const entry of origins) {
    const origin = normalizeOrigin(entry)
    if (origin === null) {
      console.error(`${SSO_ORIGIN_IGNORED}：${JSON.stringify(entry)}`)
      continue
    }
    accepted.push(origin)
  }
  return accepted
}

export function createFileReturnOriginRegistry(path: string = REGISTRY_PATH): ReturnOriginRegistry {
  return {
    async list(): Promise<readonly string[]> {
      let handle
      try {
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ELOOP' || code === 'ENOTDIR') return unavailable(`文件不可读（${code ?? '未知错误'}）`)
        throw error
      }
      try {
        const stat = await handle.stat()
        if (!stat.isFile()) return unavailable('路径不是文件')
        if (stat.size > RETURN_ORIGINS_MAX_BYTES) return unavailable(`超过 ${RETURN_ORIGINS_MAX_BYTES} 字节上限`)
        return parseOrigins(await handle.readFile({ encoding: 'utf8' }))
      } catch (error) {
        return unavailable(`读取或解析失败（${errorReason(error)}）`)
      } finally {
        await handle.close()
      }
    },
  }
}

/** 内存版白名单：测试用，不碰文件系统。 */
export function createMemoryReturnOriginRegistry(origins: readonly string[] = []): ReturnOriginRegistry {
  const snapshot = [...origins]
  return {
    async list() {
      return [...snapshot]
    },
  }
}
