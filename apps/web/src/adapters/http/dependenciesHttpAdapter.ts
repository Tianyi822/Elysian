import type { DependencyProbe, DependencyProbeReport, DependencyProbeState } from '@elysian/contracts'
import { DEPENDENCY_PROBE_STATES } from '@elysian/contracts'
import type { DependenciesAdapter } from '../../contracts/adapters'

/*
 * 浏览器侧宿主依赖检测（Docker 运行时，/api/platform/dependencies）。服务端每次
 * 请求现场探测宿主 Docker 与 Caddy 通道，这里只做 JSON 形状校验与中文错误翻译，
 * 风格与 websitesHttpAdapter 一致：解析函数全部导出，测试直接喂样本。
 */

function asObject(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    throw new Error(message)
  }
  return value as Record<string, unknown>
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  message: string,
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(message)
  }
  return value as T
}

function stringOrNull(value: unknown, message: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string') throw new Error(message)
  return value
}

/** 校验单个依赖的探测结果：state 取枚举，detail 可空。 */
export function parseDependencyProbe(value: unknown): DependencyProbe {
  const row = asObject(value, '依赖检测响应无效')
  return {
    state: oneOf<DependencyProbeState>(row.state, DEPENDENCY_PROBE_STATES, '依赖检测响应状态取值无效'),
    detail: stringOrNull(row.detail, '依赖检测响应无效'),
  }
}

/** 校验 GET /api/platform/dependencies 响应：docker 与 caddy 各一份探测结果。 */
export function parseDependencyProbeReport(body: unknown): DependencyProbeReport {
  const row = asObject(body, '依赖检测响应无效')
  return {
    docker: parseDependencyProbe(row.docker),
    caddy: parseDependencyProbe(row.caddy),
  }
}

async function requestJson(url: string): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, { cache: 'no-store' })
  } catch {
    throw new Error('依赖检测请求网络失败')
  }
  if (!response.ok) {
    const detail = await response
      .json()
      .then((body) => (body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : null))
      .catch(() => null)
    throw new Error(detail ?? `依赖检测请求失败：HTTP ${response.status}`)
  }
  try {
    return await response.json()
  } catch {
    throw new Error('依赖检测响应不是有效 JSON')
  }
}

/**
 * Docker 运行时的依赖检测 adapter：GET /api/platform/dependencies。
 * 纯读探测，无副作用；探测请求失败时抛中文错误，由引导层静默降级。
 */
export function createHttpDependenciesAdapter(baseUrl = '/api/platform/dependencies'): DependenciesAdapter {
  return {
    async probe(): Promise<DependencyProbeReport> {
      return parseDependencyProbeReport(await requestJson(baseUrl))
    },
  }
}
