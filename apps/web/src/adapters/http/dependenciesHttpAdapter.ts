import type {
  DependencyProbe,
  DependencyProbeReport,
  DependencyProbeState,
  DependencySetupResult,
  DependencySetupStep,
  DependencySetupTarget,
} from '@elysian/contracts'
import { DEPENDENCY_PROBE_STATES, DEPENDENCY_SETUP_STEPS, DEPENDENCY_SETUP_TARGETS } from '@elysian/contracts'
import type { DependenciesAdapter } from '../../contracts/adapters'
import { reportUnauthorized } from './unauthorized'

/*
 * 浏览器侧宿主依赖检测（Docker 运行时，/api/platform/dependencies）。服务端每次
 * 请求现场探测宿主 Docker 与 Caddy 通道，这里只做 JSON 形状校验与中文错误翻译，
 * 风格与 websitesHttpAdapter 一致：解析函数全部导出，测试直接喂样本。
 */

/** 响应携带文案的呈现上限：探测原因是单行中文短句，超长即非受控文本。 */
const DETAIL_MAX_LENGTH = 200

/** 不可见与控制字符（C0/C1、零宽、方向覆盖、行分隔、BOM）：压平为空格，防视觉伪装与换行拼排。 */
const INVISIBLE_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g

/**
 * 响应携带文案的统一约束：剥离不可见字符并截断到上限。探测 detail 会渲染在官方
 * 安装步骤旁、非 2xx 的 error 文案会进 danger 通知，能伪造同源响应的一方不应因此
 * 获得无长度与内容约束的社工文案位。
 */
export function sanitizeDependencyText(value: string): string {
  const flattened = value.replace(INVISIBLE_CHARACTERS, ' ')
  return flattened.length > DETAIL_MAX_LENGTH ? `${flattened.slice(0, DETAIL_MAX_LENGTH)}…` : flattened
}

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
  return sanitizeDependencyText(value)
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
    if (reportUnauthorized(response)) throw new Error('登录状态已失效，请重新登录')
    const detail = await response
      .json()
      .then((body) => {
        if (body && typeof body === 'object' && 'error' in body) {
          const error = (body as { error: unknown }).error
          // 只透传非空字符串并经统一清洗；非字符串（对象、数组等）不再 String() 拼接。
          if (typeof error === 'string' && error.length > 0) return sanitizeDependencyText(error)
        }
        return null
      })
      .catch(() => null)
    throw new Error(detail ?? `依赖检测请求失败：HTTP ${response.status}`)
  }
  try {
    return await response.json()
  } catch {
    throw new Error('依赖检测响应不是有效 JSON')
  }
}

/** 校验一步安装的成功响应。失败走 HTTP 422，不进这里。 */
export function parseDependencySetupResult(body: unknown): DependencySetupResult {
  const row = asObject(body, '依赖安装响应无效')
  if (row.ok !== true) throw new Error('依赖安装响应无效')
  if (typeof row.message !== 'string' || row.message.length === 0) throw new Error('依赖安装响应无效')
  return { ok: true, message: sanitizeDependencyText(row.message) }
}

async function errorMessage(response: Response, fallback: string): Promise<string> {
  const detail = await response
    .json()
    .then((body) => {
      if (body && typeof body === 'object' && 'error' in body) {
        const error = (body as { error: unknown }).error
        if (typeof error === 'string' && error.length > 0) return sanitizeDependencyText(error)
      }
      return null
    })
    .catch(() => null)
  return detail ?? fallback
}

/**
 * Docker 运行时的依赖检测 adapter：GET 探测，POST 执行安装的一步。
 * 探测失败时抛中文错误，由引导层静默降级；安装失败（422）收成结果，让步骤停在窗口里。
 */
export function createHttpDependenciesAdapter(baseUrl = '/api/platform/dependencies'): DependenciesAdapter {
  return {
    async probe(): Promise<DependencyProbeReport> {
      return parseDependencyProbeReport(await requestJson(baseUrl))
    },
    async setup(target: DependencySetupTarget, step: DependencySetupStep): Promise<DependencySetupResult> {
      if (!DEPENDENCY_SETUP_TARGETS.includes(target) || !DEPENDENCY_SETUP_STEPS.includes(step)) {
        throw new Error('安装步骤无效')
      }
      const url = `${baseUrl}/setup/${encodeURIComponent(target)}/${encodeURIComponent(step)}`
      let response: Response
      try {
        response = await fetch(url, { method: 'POST', cache: 'no-store' })
      } catch {
        throw new Error('依赖安装请求网络失败')
      }
      if (response.status === 422) {
        return { ok: false, message: await errorMessage(response, '这一步没有完成') }
      }
      if (!response.ok) {
        // 会话过期的安装步骤：上报后抛中文错误，而不是把「HTTP 401」透传给安装窗口。
        if (reportUnauthorized(response)) throw new Error('登录状态已失效，请重新登录')
        throw new Error(await errorMessage(response, `依赖安装请求失败：HTTP ${response.status}`))
      }
      try {
        return parseDependencySetupResult(await response.json())
      } catch (error) {
        if (error instanceof Error && error.message === '依赖安装响应无效') throw error
        throw new Error('依赖安装响应不是有效 JSON')
      }
    },
  }
}
