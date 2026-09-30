import * as http from 'node:http'
import type { WebsiteProxyStatus } from '@elysian/contracts'

/*
 * Caddy admin 客户端：HTTP-over-unix-socket，模式照 dockerTransport 的
 * requestOverSocket（零新依赖）。宿主 Caddy 的 admin 端点绑在专属目录下的
 * unix socket（缺省 /run/caddy/admin.sock，ELYSIAN_CADDY_SOCKET 可覆盖），
 * compose 以目录级 bind 把 /run/caddy 挂进面板容器——caddy 重启会以新 inode
 * 重建 socket 文件，目录级 bind 下文件替换对容器立即可见。
 */

const DEFAULT_SOCKET_PATH = '/run/caddy/admin.sock'
const TIMEOUT_MS = 5_000
const MAX_BYTES = 4 * 1024 * 1024
/** 通道不可用的固定中文 detail：连接类失败不逐码区分，唯一文案的唯一字面量。 */
export const CADDY_CHANNEL_UNAVAILABLE_DETAIL = '宿主未提供 Caddy 管理通道'

export function resolveCaddySocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.ELYSIAN_CADDY_SOCKET
  return typeof value === 'string' && value.length > 0 ? value : DEFAULT_SOCKET_PATH
}

/** admin 监听地址（Caddy 配置 JSON 的 admin.listen 取值）：`unix/<socket 路径>`。 */
export function caddyAdminListen(socketPath: string): string {
  return `unix/${socketPath}`
}

/**
 * Caddy 通道错误：unavailable 为真表示连接类失败（socket 缺失 ENOENT、权限 EACCES、
 * 无人监听 ECONNREFUSED——宿主未提供管理通道，降级跳过下发即可）；为假表示引擎侧
 * 拒绝或故障（HTTP 错误、超时、响应异常），消息带引擎原因。
 */
export class CaddyChannelError extends Error {
  constructor(
    message: string,
    readonly unavailable: boolean,
    /** 系统调用失败的 errno（非连接类，如 ENOTSOCK）：message 内嵌宿主路径，消费方按需改写文案。 */
    readonly code?: string,
  ) {
    super(message)
    this.name = 'CaddyChannelError'
  }
}

const CONNECTION_ERROR_CODES = new Set(['ENOENT', 'EACCES', 'ECONNREFUSED'])

export type CaddySocketRequest = {
  method: string
  path: string
  body?: unknown
}

/** 连接类错误整体归类为 unavailable（不逐码对外区分，中文 detail 只有一种）。 */
function channelError(error: unknown): CaddyChannelError {
  if (error instanceof CaddyChannelError) return error
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (typeof code === 'string' && CONNECTION_ERROR_CODES.has(code)) {
    return new CaddyChannelError(CADDY_CHANNEL_UNAVAILABLE_DETAIL, true)
  }
  if (typeof code === 'string') {
    return new CaddyChannelError(error instanceof Error ? error.message : String(error), false, code)
  }
  return new CaddyChannelError(error instanceof Error ? error.message : String(error), false)
}

/**
 * 通道侧错误 → 代理状态报告的唯一映射：连接类失败给固定中文 detail，引擎侧失败
 * 带引擎消息。服务层（列表探测、对账返回）消费本函数，映射与文案不落第二份。
 */
export function caddyChannelStatus(error: unknown): WebsiteProxyStatus {
  if (error instanceof CaddyChannelError) {
    return { state: 'unavailable', detail: error.unavailable ? CADDY_CHANNEL_UNAVAILABLE_DETAIL : error.message }
  }
  return { state: 'unavailable', detail: error instanceof Error ? error.message : String(error) }
}

function engineMessage(json: unknown, fallback: string): string {
  const message = (json as { message?: unknown } | null)?.message
  return typeof message === 'string' && message.length > 0 ? message : fallback
}

function requestOverSocket(
  socketPath: string,
  input: CaddySocketRequest,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const bodyPayload = input.body === undefined ? undefined : JSON.stringify(input.body)
    const req = http.request(
      {
        socketPath,
        hostname: 'localhost',
        method: input.method,
        path: input.path,
        headers:
          bodyPayload === undefined
            ? undefined
            : {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(bodyPayload),
              },
      },
      (res) => {
        const chunks: Buffer[] = []
        let total = 0
        res.on('data', (chunk: Buffer) => {
          total += chunk.length
          if (total > MAX_BYTES) {
            req.destroy()
            reject(new Error('Caddy 响应过大'))
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          if (raw.length === 0) {
            resolve({ status: res.statusCode ?? 0, json: null })
            return
          }
          try {
            resolve({ status: res.statusCode ?? 0, json: JSON.parse(raw) })
          } catch {
            reject(new Error('Caddy 响应不是有效 JSON'))
          }
        })
        res.on('error', (err) => reject(err))
      },
    )
    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy()
      reject(new Error('Caddy 请求超时'))
    })
    req.on('error', (err) => reject(err))
    if (bodyPayload !== undefined) {
      req.write(bodyPayload)
    }
    req.end()
  })
}

export type WebsiteCaddy = {
  /** admin 监听地址（生成配置时写进 admin 段，与通道自身的 socket 同一来源）。 */
  readonly adminListen: string
  /** 整配置原子替换（POST /load，失败由 Caddy 自动回滚不停机）。非 2xx 抛通道错误。 */
  load(config: unknown): Promise<void>
  /** 读取当前完整配置（GET /config/），兼作通道探测；连接类失败 unavailable 为真。 */
  currentConfig(): Promise<unknown>
}

export type WebsiteCaddyOptions = {
  socketPath?: string
  /** 测试注入：替换 socket 上的 HTTP 实现。 */
  requestImpl?: (input: CaddySocketRequest) => Promise<{ status: number; json: unknown }>
}

export function createWebsiteCaddy(options: WebsiteCaddyOptions = {}): WebsiteCaddy {
  const socketPath = options.socketPath ?? resolveCaddySocketPath()
  const request = options.requestImpl ?? ((input) => requestOverSocket(socketPath, input))

  async function guardedRequest(input: CaddySocketRequest): Promise<{ status: number; json: unknown }> {
    try {
      return await request(input)
    } catch (error) {
      throw channelError(error)
    }
  }

  return {
    adminListen: caddyAdminListen(socketPath),
    async load(config) {
      const response = await guardedRequest({ method: 'POST', path: '/load', body: config })
      if (response.status < 200 || response.status >= 300) {
        throw new CaddyChannelError(
          `Caddy 拒绝路由或证书配置（HTTP ${response.status}）`,
          false,
        )
      }
    },
    async currentConfig() {
      const response = await guardedRequest({ method: 'GET', path: '/config/' })
      if (response.status !== 200) {
        throw new CaddyChannelError(
          engineMessage(response.json, `HTTP ${response.status}`),
          false,
        )
      }
      return response.json
    },
  }
}
