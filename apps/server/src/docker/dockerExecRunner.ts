import * as http from 'node:http'
import type { ExecRunner } from './dockerExec.ts'

const API_PREFIX = '/v1.41'

function encodeEngineId(id: string): string {
  return encodeURIComponent(id)
}

/** exec 劫持流未消费输出的驻留上限；到半水位暂停 socket，消费后恢复。 */
export const DOCKER_EXEC_STDOUT_MAX_BYTES = 8 * 1024 * 1024

/**
 * 有界 chunk 队列：绝不静默删旧输出；调用方按 bufferedBytes 暂停上游。
 * 异常单块或上游不遵守暂停时显式失败，由会话的错误路径收尾。
 */
export type BoundedChunkQueue = {
  push(chunk: Uint8Array): void
  shift(): Uint8Array | undefined
  bufferedBytes(): number
}

export function createBoundedChunkQueue(maxBytes: number): BoundedChunkQueue {
  const chunks: Uint8Array[] = []
  let bufferedBytes = 0
  return {
    push(chunk) {
      if (bufferedBytes + chunk.length > maxBytes) {
        throw new Error('容器终端输出缓冲超限')
      }
      bufferedBytes += chunk.length
      chunks.push(chunk)
    },
    shift() {
      const chunk = chunks.shift()
      if (chunk !== undefined) {
        bufferedBytes -= chunk.length
      }
      return chunk
    },
    bufferedBytes: () => bufferedBytes,
  }
}

type HijackedSession = {
  write(text: string): void
  stdout: AsyncIterable<Uint8Array>
  close(): void
  exitCode(): Promise<number>
}

function createExecSession(
  socketPath: string,
  containerId: string,
  cmd: readonly string[],
  tty: boolean,
  env?: Readonly<Record<string, string>>,
): HijackedSession {
  let upstream: NodeJS.WritableStream | null = null
  let readableUpstream: NodeJS.ReadableStream | null = null
  let paused = false
  const pendingWrites: string[] = []
  const stdoutQueue = createBoundedChunkQueue(DOCKER_EXEC_STDOUT_MAX_BYTES)
  let stdoutIterator: AsyncGenerator<Uint8Array> | null = null
  const stdoutWakers: (() => void)[] = []
  let stdoutClosed = false
  let setupError: Error | null = null
  let setupDone = false
  let createRequest: http.ClientRequest | null = null
  let startRequest: http.ClientRequest | null = null
  let execId: string | null = null

  const fail = (error: Error) => {
    if (stdoutClosed) return
    setupError = error
    stdoutClosed = true
    for (const wake of stdoutWakers.splice(0)) wake()
    createRequest?.destroy()
    startRequest?.destroy()
    if (upstream && 'destroy' in upstream && typeof upstream.destroy === 'function') {
      upstream.destroy()
    }
  }

  const startSetup = () => {
    if (setupDone) return
    setupDone = true

    const createBody = JSON.stringify({
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: tty,
      Cmd: [...cmd],
      ...(env !== undefined && Object.keys(env).length > 0
        ? { Env: Object.entries(env).map(([key, value]) => `${key}=${value}`) }
        : {}),
    })

    const createReq = http.request(
      {
        socketPath,
        path: `${API_PREFIX}/containers/${encodeEngineId(containerId)}/exec`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(createBody),
        },
      },
      (createRes) => {
        const chunks: Buffer[] = []
        createRes.on('data', (chunk) => chunks.push(chunk))
        createRes.on('end', () => {
          if (stdoutClosed) return
          if ((createRes.statusCode ?? 0) < 200 || (createRes.statusCode ?? 0) >= 300) {
            fail(new Error(`创建容器 exec 失败（HTTP ${createRes.statusCode ?? 0}）`))
            return
          }
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { Id?: unknown }
            if (typeof json.Id === 'string' && json.Id.length > 0) {
              execId = json.Id
            }
          } catch {
            fail(new Error('创建容器 exec 响应无效'))
            return
          }
          if (execId === null) {
            fail(new Error('创建容器 exec 响应无效'))
            return
          }

          const startBody = JSON.stringify({ Detach: false, Tty: tty })
          let attached = false
          const pushChunk = (chunk: Buffer) => {
            if (stdoutClosed || chunk.length === 0) return
            try {
              stdoutQueue.push(new Uint8Array(chunk))
            } catch (error) {
              fail(error instanceof Error ? error : new Error('容器终端输出缓冲超限'))
              return
            }
            if (!paused && readableUpstream && stdoutQueue.bufferedBytes() >= DOCKER_EXEC_STDOUT_MAX_BYTES / 2) {
              readableUpstream.pause()
              paused = true
            }
            for (const wake of stdoutWakers.splice(0)) wake()
          }
          const attachStream = (
            readable: NodeJS.ReadableStream,
            writable: NodeJS.WritableStream,
          ) => {
            if (stdoutClosed) {
              if ('destroy' in writable && typeof writable.destroy === 'function') writable.destroy()
              return
            }
            if (attached) return
            attached = true
            upstream = writable
            readableUpstream = readable
            if (stdoutQueue.bufferedBytes() >= DOCKER_EXEC_STDOUT_MAX_BYTES / 2) {
              readable.pause()
              paused = true
            }
            for (const text of pendingWrites.splice(0)) writable.write(text)
            readable.on('data', (chunk: Buffer) => pushChunk(chunk))
            readable.on('end', () => {
              stdoutClosed = true
              for (const wake of stdoutWakers.splice(0)) wake()
            })
            readable.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))))
          }
          const startReq = http.request(
            {
              socketPath,
              path: `${API_PREFIX}/exec/${encodeEngineId(execId)}/start`,
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(startBody),
                Connection: 'Upgrade',
                Upgrade: 'tcp',
              },
            },
            (startRes) => {
              if (stdoutClosed) return
              const status = startRes.statusCode ?? 0
              if (status < 200 || status >= 300) {
                fail(new Error(`启动容器 exec 失败（HTTP ${status}）`))
                return
              }
              attachStream(startRes, startReq)
            },
          )
          startReq.on('upgrade', (startRes, sock, head) => {
            if (stdoutClosed) {
              sock.destroy()
              return
            }
            const status = startRes.statusCode ?? 0
            if (status !== 101) {
              fail(new Error(`启动容器 exec 失败（HTTP ${status}）`))
              sock.destroy()
              return
            }
            pushChunk(head)
            attachStream(sock, sock)
          })
          startReq.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))))
          startRequest = startReq
          startReq.write(startBody)
          startReq.end()
        })
        createRes.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))))
      },
    )
    createReq.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))))
    createRequest = createReq
    createReq.write(createBody)
    createReq.end()
  }

  startSetup()

  const iterateStdout = async function* (): AsyncGenerator<Uint8Array> {
    while (true) {
      const chunk = stdoutQueue.shift()
      if (chunk !== undefined) {
        if (paused && readableUpstream && stdoutQueue.bufferedBytes() < DOCKER_EXEC_STDOUT_MAX_BYTES / 4) {
          paused = false
          readableUpstream.resume()
        }
        yield chunk
        continue
      }
      if (stdoutClosed) {
        if (setupError) throw setupError
        return
      }
      await new Promise<void>((resolve) => {
        stdoutWakers.push(resolve)
      })
    }
  }

  const stdout: AsyncIterable<Uint8Array> = {
    // 单消费者流：重复取迭代器共享同一游标，消费即出队，不对同一队列重复读取。
    [Symbol.asyncIterator]() {
      stdoutIterator ??= iterateStdout()
      return stdoutIterator
    },
  }

  /** Docker 的劫持流没有退出码；流结束后从 exec inspect 读取真实状态。 */
  const exitCode = (): Promise<number> => new Promise((resolve) => {
    if (execId === null) {
      resolve(1)
      return
    }
    const request = http.request({
      socketPath,
      path: `${API_PREFIX}/exec/${encodeEngineId(execId)}/json`,
      method: 'GET',
      timeout: 2_000,
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { ExitCode?: unknown }
          resolve(response.statusCode === 200 && typeof body.ExitCode === 'number' ? body.ExitCode : 1)
        } catch {
          resolve(1)
        }
      })
      response.on('error', () => resolve(1))
    })
    request.on('timeout', () => request.destroy())
    request.on('error', () => resolve(1))
    request.end()
  })

  return {
    write(text: string) {
      if (!upstream) {
        pendingWrites.push(text)
        return
      }
      try {
        upstream.write(text)
      } catch {
        // 连接已断开
      }
    },
    stdout,
    exitCode,
    close() {
      stdoutClosed = true
      pendingWrites.length = 0
      createRequest?.destroy()
      startRequest?.destroy()
      try {
        if (upstream && 'destroy' in upstream && typeof upstream.destroy === 'function') {
          upstream.destroy()
        }
      } catch {
        // ignore
      }
      for (const wake of stdoutWakers.splice(0)) wake()
    },
  }
}

/** 为指定容器构造 {@link ExecRunner}（每次 run 新建 exec 会话）。 */
export function createContainerExecRunner(socketPath: string, containerId: string): ExecRunner {
  return {
    run(cmd, tty, env) {
      return createExecSession(socketPath, containerId, cmd, tty, env)
    },
  }
}
