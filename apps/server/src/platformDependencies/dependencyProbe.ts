import type { DependencyProbe, DependencyProbeReport } from '@elysian/contracts'
import { resolveSocketPath } from '../docker/dockerHostDeps.ts'
import { assertEngineApi, createDockerTransport, type DockerTransport } from '../docker/dockerTransport.ts'
import {
  CADDY_CHANNEL_UNAVAILABLE_DETAIL,
  CaddyChannelError,
  createWebsiteCaddy,
  resolveCaddySocketPath,
  type WebsiteCaddy,
} from '../websites/websitesCaddy.ts'

/*
 * 宿主依赖检测的探测实现：给定 env，现场探测 Docker Engine 与 Caddy 管理通道的
 * 就绪性。零新通道——docker 复用容器片的版本探针（assertEngineApi），caddy 复用
 * 网站片的通道探测（currentConfig），socket 路径分别经 resolveSocketPath /
 * resolveCaddySocketPath 解析（ELYSIAN_DOCKER_SOCKET / ELYSIAN_CADDY_SOCKET
 * 覆盖即天然模拟机制）。纯读：不执行安装、不写系统文件；每次调用都新建 transport
 * 与 caddy 对象（两者只是 socketPath 的闭包封装，无连接无状态），装配期缓存反而
 * 会让「重新检测」拿不到新事实。
 */

/** Docker 连接类失败的固定中文 detail：未安装或未接通不逐码区分，唯一文案的唯一字面量。 */
export const DOCKER_UNAVAILABLE_DETAIL = 'Docker 未安装或未接通'

/**
 * 非连接类系统错误（errno 如 ENOTSOCK、ETIMEDOUT——socket 路径指向非 socket 文件、
 * 连接中途系统级失败）的固定中文 detail：此类错误的 message 形如
 * `connect ENOTSOCK <宿主绝对路径>`，属于内嵌宿主路径的非受控文本，不逐字透传。
 */
export const DOCKER_SYSTEM_ERROR_DETAIL = 'Docker 连接异常'

/** Caddy 侧同口径的系统错误固定文案（errno 经 CaddyChannelError.code 辨别）。 */
export const CADDY_SYSTEM_ERROR_DETAIL = 'Caddy 连接异常'

/** 连接类错误码集合：与 websitesCaddy 的 CONNECTION_ERROR_CODES 同集，不逐码对外区分。 */
const CONNECTION_ERROR_CODES = new Set(['ENOENT', 'EACCES', 'ECONNREFUSED'])

function isConnectionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' && CONNECTION_ERROR_CODES.has(code)
}

/** 系统级 errno 错误（含经 channelError 包装、携带 code 的 CaddyChannelError）：message 不透传。 */
function isSystemErrno(error: unknown): boolean {
  return typeof (error as NodeJS.ErrnoException | null)?.code === 'string'
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : String(error)
}

async function probeDocker(transport: DockerTransport): Promise<DependencyProbe> {
  try {
    await assertEngineApi(transport)
    return { state: 'ok', detail: null }
  } catch (error) {
    if (isConnectionError(error)) {
      return { state: 'missing', detail: DOCKER_UNAVAILABLE_DETAIL }
    }
    if (isSystemErrno(error)) {
      return { state: 'error', detail: DOCKER_SYSTEM_ERROR_DETAIL }
    }
    return { state: 'error', detail: messageOf(error) }
  }
}

async function probeCaddy(caddy: WebsiteCaddy): Promise<DependencyProbe> {
  try {
    await caddy.currentConfig()
    return { state: 'ok', detail: null }
  } catch (error) {
    if (error instanceof CaddyChannelError && error.unavailable) {
      return { state: 'missing', detail: CADDY_CHANNEL_UNAVAILABLE_DETAIL }
    }
    if (isSystemErrno(error)) {
      return { state: 'error', detail: CADDY_SYSTEM_ERROR_DETAIL }
    }
    return { state: 'error', detail: messageOf(error) }
  }
}

/** 探测入口：probe 带 env 参数（缺省 process.env），env 覆盖即模拟缺失的机制。 */
export type DependencyProber = {
  probe(env?: NodeJS.ProcessEnv): Promise<DependencyProbeReport>
}

export type DependencyProbeOptions = {
  /** 测试注入：替换 docker transport 工厂（缺省 createDockerTransport，真实 socket）。 */
  createTransport?: (socketPath: string) => DockerTransport
  /** 测试注入：替换 caddy 客户端工厂（缺省 createWebsiteCaddy，真实 socket）。 */
  createCaddy?: (socketPath: string) => WebsiteCaddy
}

/**
 * 依赖探针工厂。两探测 Promise.all 并行（最坏耗时 5 秒，串行会放大到 8 秒）；
 * 报告只含事实，前端按「Docker 高于 Caddy」的优先级编排引导。
 */
export function createDependencyProbe(options: DependencyProbeOptions = {}): DependencyProber {
  const createTransport = options.createTransport ?? ((socketPath) => createDockerTransport({ socketPath }))
  const createCaddy = options.createCaddy ?? ((socketPath) => createWebsiteCaddy({ socketPath }))
  return {
    async probe(env = process.env): Promise<DependencyProbeReport> {
      const [docker, caddy] = await Promise.all([
        probeDocker(createTransport(resolveSocketPath(env))),
        probeCaddy(createCaddy(resolveCaddySocketPath(env))),
      ])
      return { docker, caddy }
    },
  }
}
