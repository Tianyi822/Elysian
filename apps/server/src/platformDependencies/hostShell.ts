import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { resolveSocketPath } from '../docker/dockerHostDeps.ts'
import { createDockerTransport, type DockerTransport } from '../docker/dockerTransport.ts'
import {
  SETUP_FAILURE_ENGINE,
  SETUP_FAILURE_HOST,
  SETUP_FAILURE_IMAGE,
  SETUP_FAILURE_TIMEOUT,
} from './dependencySetupScripts.ts'

/*
 * 在宿主上执行一段固定脚本。
 * 进程不在容器里时直接 execFile（裸机部署）。进程在容器里时，面板自己没有宿主的
 * 包管理器，改经已经挂上的引擎 socket 起一个一次性特权容器：alpine 只提供
 * nsenter，进去之后跑的是宿主的 /bin/sh。Caddy 不会装进这个容器，用完即删。
 * 引擎 socket 本身就是宿主根权限；这里不接受请求里的命令，只跑调用方给的常量脚本。
 */

const execFileAsync = promisify(execFile)

const API_PREFIX = '/v1.41'
const SETUP_IMAGE = 'alpine:3.20'
const SETUP_NAME = 'elysian-host-setup'
const OUTPUT_TAIL = 32_000

const CONNECTION_CODES = new Set(['ENOENT', 'EACCES', 'ECONNREFUSED', 'ENOTSOCK'])

export class HostCommandError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HostCommandError'
  }
}

export type HostCommandResult = {
  code: number
  output: string
}

export type HostCommandRunner = {
  run(script: string, timeoutMs: number): Promise<HostCommandResult>
}

type HostExecFile = (
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv; encoding: 'utf8' },
) => Promise<{ stdout: string; stderr: string }>

export type HostCommandRunnerOptions = {
  /** 缺省看 /.dockerenv。测试显式传入，避免误跑到真实引擎。 */
  inContainer?: boolean
  execFile?: HostExecFile
  createTransport?: () => DockerTransport
  env?: NodeJS.ProcessEnv
}

function capTail(text: string): string {
  const cleaned = text.replace(/\u0000/g, '')
  return cleaned.length <= OUTPUT_TAIL ? cleaned : cleaned.slice(-OUTPUT_TAIL)
}

function toText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Uint8Array) return new TextDecoder().decode(value)
  return ''
}

function minimalEnv(): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    DEBIAN_FRONTEND: 'noninteractive',
    LANG: 'C.UTF-8',
  }
}

async function runOnHost(exec: HostExecFile, script: string, timeoutMs: number): Promise<HostCommandResult> {
  try {
    const { stdout, stderr } = await exec('/bin/sh', ['-c', script], {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      env: minimalEnv(),
      encoding: 'utf8',
    })
    return { code: 0, output: capTail(`${stdout}\n${stderr}`) }
  } catch (error) {
    const extra = error as Error & {
      code?: number | string
      stdout?: unknown
      stderr?: unknown
      killed?: boolean
    }
    if (extra?.killed === true || extra?.code === 'ETIMEDOUT') {
      throw new HostCommandError(SETUP_FAILURE_TIMEOUT)
    }
    if (typeof extra?.code === 'number') {
      return { code: extra.code, output: capTail(`${toText(extra.stdout)}\n${toText(extra.stderr)}`) }
    }
    throw new HostCommandError(SETUP_FAILURE_HOST)
  }
}

function asEngineError(error: unknown): never {
  if (error instanceof HostCommandError) throw error
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (typeof code === 'string' && CONNECTION_CODES.has(code)) {
    throw new HostCommandError(SETUP_FAILURE_ENGINE)
  }
  throw new HostCommandError(SETUP_FAILURE_IMAGE)
}

function containerId(json: unknown): string | null {
  if (!json || typeof json !== 'object' || !('Id' in json)) return null
  const id = (json as { Id: unknown }).Id
  return typeof id === 'string' && /^[a-f0-9]{12,64}$/.test(id) ? id : null
}

function chunksToText(chunks: readonly Uint8Array[]): string {
  let text = ''
  for (const chunk of chunks) text += new TextDecoder().decode(chunk)
  return text
}

async function call(
  transport: DockerTransport,
  method: string,
  path: string,
  timeoutMs: number,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  try {
    return await transport.request({ method, path, body, timeoutMs, maxBytes: 1_048_576 })
  } catch (error) {
    asEngineError(error)
  }
}

async function ensureImage(transport: DockerTransport): Promise<void> {
  const inspect = await call(
    transport,
    'GET',
    `${API_PREFIX}/images/${encodeURIComponent(SETUP_IMAGE)}/json`,
    15_000,
  )
  if (inspect.status === 200) return
  if (!transport.pullCreate) throw new HostCommandError(SETUP_FAILURE_IMAGE)
  let pulled: { status: number; chunks: readonly Uint8Array[] }
  try {
    pulled = await transport.pullCreate({
      path: `${API_PREFIX}/images/create?fromImage=${encodeURIComponent('alpine')}&tag=3.20`,
      timeoutMs: 120_000,
      maxBytes: 32 * 1024 * 1024,
    })
  } catch (error) {
    asEngineError(error)
  }
  const body = chunksToText(pulled.chunks)
  if (pulled.status !== 200 || /"error"\s*:/.test(body)) {
    throw new HostCommandError(SETUP_FAILURE_IMAGE)
  }
}

function containerBody(script: string): Record<string, unknown> {
  return {
    Image: SETUP_IMAGE,
    // Tty 让 logs 是纯文本，而不是带 8 字节头的多路复用流。
    Tty: true,
    Entrypoint: ['nsenter', '-t', '1', '-m', '-u', '-i', '-n', '-p', '--', '/bin/sh', '-c'],
    Cmd: [script],
    HostConfig: {
      Privileged: true,
      PidMode: 'host',
      NetworkMode: 'host',
      AutoRemove: false,
    },
  }
}

async function createContainer(transport: DockerTransport, script: string): Promise<string> {
  const path = `${API_PREFIX}/containers/create?name=${encodeURIComponent(SETUP_NAME)}`
  let created = await call(transport, 'POST', path, 30_000, containerBody(script))
  if (created.status === 409) {
    await call(
      transport,
      'DELETE',
      `${API_PREFIX}/containers/${encodeURIComponent(SETUP_NAME)}?force=1`,
      15_000,
    ).catch(() => undefined)
    created = await call(transport, 'POST', path, 30_000, containerBody(script))
  }
  const id = containerId(created.json)
  if ((created.status !== 201 && created.status !== 200) || id === null) {
    throw new HostCommandError(SETUP_FAILURE_IMAGE)
  }
  return id
}

async function runViaEngine(transport: DockerTransport, script: string, timeoutMs: number): Promise<HostCommandResult> {
  await ensureImage(transport)
  const id = await createContainer(transport, script)
  try {
    const started = await call(transport, 'POST', `${API_PREFIX}/containers/${id}/start`, 30_000)
    if (started.status !== 204 && started.status !== 200) {
      throw new HostCommandError(SETUP_FAILURE_IMAGE)
    }
    const waited = await call(transport, 'POST', `${API_PREFIX}/containers/${id}/wait`, timeoutMs)
    const statusCode = waited.json !== null && typeof waited.json === 'object' && 'StatusCode' in waited.json
      ? (waited.json as { StatusCode: unknown }).StatusCode
      : null
    if (waited.status !== 200 || typeof statusCode !== 'number') {
      throw new HostCommandError(SETUP_FAILURE_IMAGE)
    }
    let output = ''
    if (transport.pullCreate) {
      try {
        const logs = await transport.pullCreate({
          method: 'GET',
          path: `${API_PREFIX}/containers/${id}/logs?stdout=1&stderr=1`,
          timeoutMs: 15_000,
          maxBytes: 1_048_576,
        })
        if (logs.status === 200) output = chunksToText(logs.chunks)
      } catch {
        output = ''
      }
    }
    return { code: statusCode, output: capTail(output) }
  } finally {
    await call(transport, 'DELETE', `${API_PREFIX}/containers/${id}?force=1`, 15_000).catch(() => undefined)
  }
}

export function createHostCommandRunner(options: HostCommandRunnerOptions = {}): HostCommandRunner {
  const inContainer = options.inContainer ?? existsSync('/.dockerenv')
  const exec = options.execFile ?? ((file, args, execOptions) => execFileAsync(file, [...args], execOptions))
  const openTransport = options.createTransport
    ?? (() => createDockerTransport({ socketPath: resolveSocketPath(options.env ?? process.env) }))
  return {
    async run(script, timeoutMs) {
      if (!inContainer) return runOnHost(exec, script, timeoutMs)
      try {
        return await runViaEngine(openTransport(), script, timeoutMs)
      } catch (error) {
        asEngineError(error)
      }
    },
  }
}
