import type { Context, MiddlewareHandler } from 'hono'
import { matchedRoutes } from 'hono/route'
import type { LoginLogStatus, OperationLogCategory, OperationLogOutcome } from '@elysian/contracts'
import { AUTH_MOUNT } from '../shared/apiMounts.ts'
import { peerAddressFromEnv } from './loginClient.ts'
import { OPERATION_DESCRIPTORS, extractPathParams, type OperationDescriptor } from './operationDescriptors.ts'
import type { LogsService } from './logsService.ts'

/*
 * 操作日志的采集中间件：挂在 app 层（app.use('/api/*', ...)）、**在所有片路由之前**，
 * 因此任何一片的任何写端点都被它包住，各片 handler 里没有「记日志」的调用，也就没有
 * 「忘了记」的位置。
 *
 * 客户端无法绕开、也无法伪造：
 * - 没有写入口：「/api/logs/*」只有 GET 与 clear，不存在接受日志正文的端点；
 * - 记录内容全部由服务端生成：at/seq 取服务端时钟与进程计数器，category/action/target
 *   来自描述符表，result/httpStatus 取自最终响应，actor 是常量——客户端提交的任何字段
 *   都不参与，也不存在「客户端可控值直接变成审计事实」的路径；
 * - 凭据隔离：**只有描述符声明了 summarize 的端点才会被读取请求体**（对象名要取体时该端点
 *   本来就有摘要，两者同桌），密码类端点因此结构性地不可能泄漏到日志——判断发生在 clone
 *   之前，未声明的端点恒不 clone、恒不读体；
 * - 净化：落盘的 action/target/summary/method/path 与运行日志的 source/message 一样，
 *   在写侧全部过 normalizeSingleLine（剥换行与控制字符、长度封顶），因此日志行不可能被
 *   参数值破坏成两行、也不可能塞进 ANSI 转义伪造日志行。
 *
 * 路由定位必须用 hono/route 的 matchedRoutes 而不是 routePath：实测（hono 4.13.8）被
 * 同源守卫短路的跨源写请求里，routePath(c) 是通配 `PUT /api/security/ssh/*`，拿着它查
 * 描述符表必然未命中——越权尝试就不会进审计；matchedRoutes(c) 此时仍含具体路由。
 *
 * 记录时机与失败处置：await next() 之后读最终状态码（子应用各自有 onError，500 由子应用
 * 映射，父 onError 收不到，所以 5xx 的运行日志在这里按 c.res.status 记）；写日志失败只
 * console.error，绝不让业务请求失败——动作已经真实执行，回 500 是撒谎。
 */

/** 采集需要的出口：写操作日志、写运行日志，以及登录端点额外的登录日志。 */
export type OperationAuditLogs = Pick<LogsService, 'recordOperation' | 'log' | 'recordLogin'>

/** 登录日志只记这一条路由：最终状态码 < 400 为成功，其余（401 / 400 / 429 / 5xx）为失败。 */
const LOGIN_ATTEMPT_KEY = `POST ${AUTH_MOUNT}/login`

/** 摘要读体的上限：超限即摘要退化为 null（读体只为生成摘要，不值得为它承担任意大小的解析）。 */
export const OPERATION_SUMMARY_BODY_MAX_BYTES = 8 * 1024

/** 运行日志里「一次操作」镜像与「请求处理失败」两个来源标识。 */
export const OPERATION_LOG_SOURCE = 'logs.operation'
export const HTTP_LOG_SOURCE = 'server.http'

export type OperationRecording = {
  category: OperationLogCategory
  action: string
  target?: string | null
  result: OperationLogOutcome
  summary?: string | null
  method?: string | null
  path?: string | null
  httpStatus?: number | null
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 写日志的失败出口：失败只打印到 stderr（写盘失败已由写入器计入 failedWrites，
 * 面板以 failedWrites 提示审计缺口），绝不向上抛——不能因为记不下来就让业务请求失败。
 */
async function safeWrite(task: () => Promise<void>): Promise<void> {
  try {
    await task()
  } catch (error) {
    console.error(`Elysian 操作日志采集失败：${describeError(error)}`)
  }
}

/** 描述符函数的取值出口：函数抛错只让该字段退化为 null，不吃掉已经生成的响应。 */
function callSafely(task: () => string | null): string | null {
  try {
    return task()
  } catch (error) {
    console.error(`Elysian 操作日志字段计算失败：${describeError(error)}`)
    return null
  }
}

/** 动作对象的取值：字符串是常量，函数从（已经按白名单读出的）请求体与路径参数里取。 */
function targetOf(
  descriptor: OperationDescriptor,
  body: Record<string, unknown> | null,
  params: Record<string, string>,
): string | null {
  if (typeof descriptor.target === 'function') return descriptor.target({ body, params })
  return descriptor.target ?? null
}

function resultOf(status: number): OperationLogOutcome {
  return status < 400 ? 'success' : 'failure'
}

/**
 * 记录一次操作：先写操作日志，再镜像一条运行日志（满足「运行日志包括平台的运行、操作等」）。
 * 中间件与显式调用点（终端会话）共用它，保证两处的落盘形状与镜像文案只有一份。
 */
export async function recordPanelOperation(logs: OperationAuditLogs, input: OperationRecording): Promise<void> {
  const result = input.result
  await safeWrite(() =>
    logs.recordOperation({
      category: input.category,
      action: input.action,
      target: input.target ?? null,
      result,
      summary: input.summary ?? null,
      method: input.method ?? null,
      path: input.path ?? null,
      httpStatus: input.httpStatus ?? null,
    }),
  )
  await safeWrite(() =>
    logs.log(
      result === 'success' ? 'info' : 'warning',
      OPERATION_LOG_SOURCE,
      `操作：${input.action}（${result === 'success' ? '成功' : '失败'}）`,
    ),
  )
}

/**
 * 具体路由定位：method 与请求一致、path 不含 `*` 的那一条。
 * 同一请求里它要么唯一，要么不存在（未命中任何具体路由 = 404/兜底，不记录）。
 */
function locateRoute(c: Context, method: string): string | null {
  for (const route of matchedRoutes(c)) {
    if (route.method !== method) continue
    if (route.path.includes('*')) continue
    return route.path
  }
  return null
}

/** 描述符是否要求读请求体：唯一开关是 summarize（见文件头与 operationDescriptors）。 */
function readsBody(descriptor: OperationDescriptor): boolean {
  return descriptor.summarize !== undefined
}

/**
 * 读一份请求体（最多 maxBytes）：超限、空体、坏 JSON、非对象一律回 null。
 * 只有声明了 summarize 的描述符才会走到这里（凭据隔离的唯一开关）。
 */
async function readJsonUpTo(request: Request, maxBytes: number): Promise<Record<string, unknown> | null> {
  const stream = request.body
  if (stream === null) return null
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > maxBytes) {
        void reader.cancel().catch(() => undefined)
        return null
      }
      chunks.push(value)
    }
  } catch {
    return null
  }
  const merged = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  const text = new TextDecoder().decode(merged)
  if (text.trim() === '') return null
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * 采集中间件工厂：app.ts 以 `app.use('/api/*', createOperationAudit(service))` 注册在
 * 所有片路由之前。GET/HEAD 只读不谈，直接放行，不记录、也不克隆请求体。
 */
export function createOperationAudit(logs: OperationAuditLogs): MiddlewareHandler {
  return async (c, next) => {
    const method = c.req.method.toUpperCase()
    if (method === 'GET' || method === 'HEAD') {
      await next()
      return
    }

    // 路由定位与描述符查找在 next() 之前完成（实测此时 matchedRoutes 已含具体路由）：
    // 未声明 summarize 的端点因此恒不 clone、恒不读体，凭据隔离靠的就是这个次序。
    const routePath = locateRoute(c, method)
    const descriptor = routePath === null ? undefined : OPERATION_DESCRIPTORS[`${method} ${routePath}`]
    const cloned = descriptor !== undefined && readsBody(descriptor) && c.req.raw.body !== null ? c.req.raw.clone() : null

    let status: number
    let thrown: unknown
    try {
      await next()
      status = c.res.status
    } catch (error) {
      // 错误在父层/中间件里被抛出：按 500 记一条 failure 与一条 error 运行日志，再把异常原样抛出
      // （映射回响应由 app.onError 负责，错误映射一字不变）。
      thrown = error
      status = 500
    }

    const body = cloned === null ? null : await readJsonUpTo(cloned, OPERATION_SUMMARY_BODY_MAX_BYTES)
    const params = routePath === null ? {} : extractPathParams(routePath, c.req.path)
    // 描述符函数抛错只让该字段退化（摘要为空、对象为 null），绝不吃掉已经生成的响应。
    const summarize = descriptor?.summarize
    const summary = summarize === undefined ? null : callSafely(() => summarize({ body, params, status }))
    const target = descriptor === undefined ? null : callSafely(() => targetOf(descriptor, body, params))

    if (descriptor !== undefined) {
      await recordPanelOperation(logs, {
        category: descriptor.category,
        action: descriptor.action,
        target,
        result: resultOf(status),
        summary,
        method,
        // path 只取 pathname（c.req.path 就是不含 query 的路径）；净化在写侧统一做。
        path: c.req.path,
        httpStatus: status,
      })
    }

    // 登录日志与操作日志分开落盘：只记登录端点，字段是对端地址与 User-Agent，不读请求体。
    if (routePath !== null && `${method} ${routePath}` === LOGIN_ATTEMPT_KEY) {
      const statusValue: LoginLogStatus = resultOf(status) === 'success' ? 'success' : 'failure'
      await safeWrite(() =>
        logs.recordLogin({
          ip: peerAddressFromEnv(c.env, c.req.raw),
          userAgent: c.req.header('user-agent') ?? '',
          status: statusValue,
        }),
      )
    }

    // 5xx 的运行日志：无论描述符是否命中都记（常规 5xx 的唯一可靠来源，见文件头）。
    // 整片 503 不记：服务根本不可用、动作没发生，宿主机本地开发下会刷屏。
    if (status >= 500 && status !== 503) {
      await safeWrite(() => logs.log('error', HTTP_LOG_SOURCE, `请求处理失败：${method} ${c.req.path} — HTTP ${status}`))
    }

    if (thrown !== undefined) throw thrown
  }
}
