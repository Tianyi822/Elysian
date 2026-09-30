import type { DependencySetupResult, DependencySetupTarget } from '@elysian/contracts'
import { CADDYFILE_GLOBAL_UNCLOSED, ensureCaddyAdminSocket } from './caddyfileAdmin.ts'
import {
  CADDY_ENABLE_SCRIPT,
  CADDY_INSTALL_SCRIPT,
  DOCKER_ENABLE_SCRIPT,
  DOCKER_INSTALL_SCRIPT,
  READ_CADDYFILE_SCRIPT,
  SETUP_FAILURE_BUSY,
  SETUP_FAILURE_GENERIC,
  SETUP_FAILURE_SOCKET_PATH,
  SETUP_FAILURE_STEP,
  SETUP_KNOWN_FAILURES,
  writeCaddyfileScript,
} from './dependencySetupScripts.ts'
import { HostCommandError, type HostCommandResult, type HostCommandRunner } from './hostShell.ts'
import { resolveCaddySocketPath } from '../websites/websitesCaddy.ts'

/*
 * 把「安装 Docker / 安装 Caddy」拆成固定步骤。每一步要么短路由过（已经完成），
 * 要么在宿主上跑一段常量脚本。确认通道不在这里：那一步只是重新探测。
 * 同时只允许一步在跑，避免两个 apt 叠在一起。
 */

const CADDY_SOCKET_PATH = /^\/run\/caddy\/[A-Za-z0-9._-]+\.sock$/

const STEP_TIMEOUT_MS = {
  installDocker: 240_000,
  installCaddy: 180_000,
  configure: 30_000,
  enable: 90_000,
} as const

export type DependencySetup = {
  run(target: DependencySetupTarget, step: string): Promise<DependencySetupResult>
}

export type DependencySetupOptions = {
  host: HostCommandRunner
  /** 缺省读 ELYSIAN_CADDY_SOCKET。测试注入，避免脚本吃到意外路径。 */
  socketPath?: () => string
}

function failureMessage(output: string): string {
  for (const known of SETUP_KNOWN_FAILURES) {
    if (output.includes(known)) return known
  }
  const tail = output
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/ELYSIAN_[A-Z0-9_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(-180)
  if (tail.length === 0) return SETUP_FAILURE_GENERIC
  return `${SETUP_FAILURE_GENERIC}：${tail}`
}

function interpret(result: HostCommandResult, done: string, already: string): DependencySetupResult {
  if (result.output.includes('ELYSIAN_ALREADY')) return { ok: true, message: already }
  if (result.code === 0) return { ok: true, message: done }
  return { ok: false, message: failureMessage(result.output) }
}

function withTrailingNewline(value: string): string {
  if (value.length === 0 || value.endsWith('\n')) return value
  return `${value}\n`
}

export function createDependencySetup(options: DependencySetupOptions): DependencySetup {
  const socketPathOf = options.socketPath ?? (() => resolveCaddySocketPath())
  let busy = false

  async function readCaddyfile(): Promise<string> {
    const result = await options.host.run(READ_CADDYFILE_SCRIPT, STEP_TIMEOUT_MS.configure)
    if (result.code !== 0) {
      throw new HostCommandError(failureMessage(result.output))
    }
    const matched = /ELYSIAN_B64:([A-Za-z0-9+/=]*)/.exec(result.output)
    const payload = matched?.[1]
    if (payload !== undefined) return Buffer.from(payload, 'base64').toString('utf8')
    if (result.output.includes('ELYSIAN_EMPTY')) return ''
    throw new HostCommandError(SETUP_FAILURE_GENERIC)
  }

  async function configure(): Promise<DependencySetupResult> {
    const socketPath = socketPathOf()
    if (socketPath.includes('..') || !CADDY_SOCKET_PATH.test(socketPath)) {
      return { ok: false, message: SETUP_FAILURE_SOCKET_PATH }
    }
    const current = await readCaddyfile()
    let next: string
    try {
      next = ensureCaddyAdminSocket(current, socketPath)
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      if (message === CADDYFILE_GLOBAL_UNCLOSED) return { ok: false, message }
      return { ok: false, message: SETUP_FAILURE_GENERIC }
    }
    if (next === withTrailingNewline(current.replace(/\r\n/g, '\n'))) {
      return { ok: true, message: '管理端点已是目标地址' }
    }
    const written = await options.host.run(writeCaddyfileScript(next), STEP_TIMEOUT_MS.configure)
    return interpret(written, '管理端点已写入', '管理端点已是目标地址')
  }

  async function execute(target: DependencySetupTarget, step: string): Promise<DependencySetupResult> {
    if (target === 'docker' && step === 'install') {
      const result = await options.host.run(DOCKER_INSTALL_SCRIPT, STEP_TIMEOUT_MS.installDocker)
      return interpret(result, 'Docker 已安装', 'Docker 已经在运行')
    }
    if (target === 'docker' && step === 'enable') {
      const result = await options.host.run(DOCKER_ENABLE_SCRIPT, STEP_TIMEOUT_MS.enable)
      return interpret(result, 'Docker 已设为开机自启', 'Docker 已设为开机自启')
    }
    if (target === 'caddy' && step === 'install') {
      const result = await options.host.run(CADDY_INSTALL_SCRIPT, STEP_TIMEOUT_MS.installCaddy)
      return interpret(result, 'Caddy 已安装', 'Caddy 已经装好')
    }
    if (target === 'caddy' && step === 'configure') return configure()
    if (target === 'caddy' && step === 'enable') {
      const result = await options.host.run(CADDY_ENABLE_SCRIPT, STEP_TIMEOUT_MS.enable)
      return interpret(result, 'Caddy 已启动', 'Caddy 已启动')
    }
    return { ok: false, message: SETUP_FAILURE_STEP }
  }

  return {
    async run(target, step) {
      if (busy) return { ok: false, message: SETUP_FAILURE_BUSY }
      busy = true
      try {
        return await execute(target, step)
      } catch (error) {
        if (error instanceof HostCommandError) return { ok: false, message: error.message }
        return { ok: false, message: SETUP_FAILURE_GENERIC }
      } finally {
        busy = false
      }
    },
  }
}
