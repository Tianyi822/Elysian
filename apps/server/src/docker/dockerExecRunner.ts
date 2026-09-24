import * as http from 'node:http'
import type { ExecRunner } from './dockerExec.ts'

const API_PREFIX = '/v1.41'

function encodeEngineId(id: string): string {
  return encodeURIComponent(id)
}

type HijackedSession = {
  write(text: string): void
  stdout: AsyncIterable<Uint8Array>
  close(): void
}

function createExecSession(
  socketPath: string,
  containerId: string,
  cmd: readonly string[],
  tty: boolean,
): HijackedSession {
  let socket: http.ClientRequest | null = null
  const stdoutChunks: Uint8Array[] = []
  const stdoutWakers: (() => void)[] = []
  let stdoutClosed = false
  let setupError: Error | null = null
  let setupDone = false

  const fail = (error: Error) => {
    setupError = error
    stdoutClosed = true
    for (const wake of stdoutWakers.splice(0)) wake()
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
          if ((createRes.statusCode ?? 0) < 200 || (createRes.statusCode ?? 0) >= 300) {
            fail(new Error(`创建容器 exec 失败（HTTP ${createRes.statusCode ?? 0}）`))
            return
          }
          let execId: string | null = null
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
              if ((startRes.statusCode ?? 0) < 200 || (startRes.statusCode ?? 0) >= 300) {
                fail(new Error(`启动容器 exec 失败（HTTP ${startRes.statusCode ?? 0}）`))
                return
              }
              startRes.on('data', (chunk: Buffer) => {
                stdoutChunks.push(new Uint8Array(chunk))
                for (const wake of stdoutWakers.splice(0)) wake()
              })
              startRes.on('end', () => {
                stdoutClosed = true
                for (const wake of stdoutWakers.splice(0)) wake()
              })
              startRes.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))))
            },
          )
          startReq.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))))
          startReq.write(startBody)
          startReq.end()
          socket = startReq
        })
        createRes.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))))
      },
    )
    createReq.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))))
    createReq.write(createBody)
    createReq.end()
  }

  startSetup()

  const stdout: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() {
      let index = 0
      while (true) {
        while (index < stdoutChunks.length) {
          yield stdoutChunks[index]!
          index += 1
        }
        if (stdoutClosed) {
          if (setupError) throw setupError
          return
        }
        await new Promise<void>((resolve) => {
          stdoutWakers.push(resolve)
        })
      }
    },
  }

  return {
    write(text: string) {
      if (!socket) return
      try {
        socket.write(text)
      } catch {
        // 连接已断开
      }
    },
    stdout,
    close() {
      stdoutClosed = true
      try {
        socket?.destroy()
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
    run(cmd, tty) {
      return createExecSession(socketPath, containerId, cmd, tty)
    },
  }
}
