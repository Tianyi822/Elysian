import { describe, expect, it, vi } from 'vitest'
import type { ExecRunner } from './dockerExec.ts'
import { DOCKER_EXEC_CLEANUP_SCRIPT, DOCKER_SHELL_PROBE_SCRIPT } from './dockerExec.ts'
import {
  createDockerExecSessions,
  DOCKER_EXEC_SERVICE_IDLE_MS,
} from './dockerExecSessions.ts'

function createOptions(nowMs: () => number) {
  return {
    createExecRunner: () => {
      throw new Error('测试不应创建 exec 会话')
    },
    identityForContainer: () => ({ user: 'root', hostLabel: 'test', homeDir: '/' }),
    listDir: async () => [] as readonly string[],
    listCommands: async () => [] as readonly string[],
    now: nowMs,
  }
}

describe('createDockerExecSessions', () => {
  it('WS 帧走真实会话编排：容器启动一次、固定提示符、输出与补全、断开清理', async () => {
    const encoder = new TextEncoder()
    const writes: string[] = []
    const cleanupCommands: string[][] = []
    const listCommands = vi.fn(async (_containerId: string, kind: 'bash' | 'sh') => {
      expect(kind).toBe('bash')
      return ['echo']
    })
    const listDir = vi.fn(async (_containerId: string, path: string) => {
      expect(path).toBe('/')
      return ['app']
    })
    let pushOutput: (text: string) => void = () => {}
    let finishOutput: () => void = () => {}
    const createExecRunner = (): ExecRunner => ({
      run(cmd) {
        if (cmd[2] === DOCKER_SHELL_PROBE_SCRIPT) {
          return {
            write: () => {},
            stdout: (async function* () { yield encoder.encode('bash=yes\nstty=yes\n') })(),
            close: () => {},
          }
        }
        if (cmd[2] === DOCKER_EXEC_CLEANUP_SCRIPT) {
          cleanupCommands.push([...cmd])
          return { write: () => {}, stdout: (async function* () {})(), close: () => {} }
        }
        expect(cmd).toEqual(['/bin/bash', '--noediting'])
        const chunks: Uint8Array[] = []
        const wake: Array<() => void> = []
        let closed = false
        pushOutput = (text) => {
          chunks.push(encoder.encode(text))
          for (const resume of wake.splice(0)) resume()
        }
        finishOutput = () => {
          closed = true
          for (const resume of wake.splice(0)) resume()
        }
        return {
          write(text) {
            writes.push(text)
            if (text.includes('READY:')) pushOutput('\x01READY:123\x02\n\x01PWD:/\x02\n')
            if (text === 'echo hi\n') pushOutput('hi\n\x01PWD:/\x02\n')
          },
          stdout: (async function* () {
            while (true) {
              const chunk = chunks.shift()
              if (chunk) { yield chunk; continue }
              if (closed) return
              await new Promise<void>((resolve) => wake.push(resolve))
            }
          })(),
          close: finishOutput,
        }
      },
    })
    const sessions = createDockerExecSessions({
      createExecRunner,
      identityForContainer: () => ({ user: 'root', hostLabel: 'ctr', homeDir: '/' }),
      listCommands,
      listDir,
    })
    const sent: Array<Record<string, unknown>> = []
    const closed: Array<{ code: number; reason: string }> = []
    const conn = {
      readyState: 1,
      send: (text: string) => sent.push(JSON.parse(text) as Record<string, unknown>),
      close: (code: number, reason: string) => closed.push({ code, reason }),
    }
    const ws = sessions.createWsEvents('ctr-1')
    ws.onOpen(undefined, conn)
    await vi.waitFor(() => expect(sent[0]?.type).toBe('ready'))
    expect((sent[0]?.session as { prompt: string }).prompt).toBe('$ ')
    expect(sent[0]?.completion).toEqual({ commands: ['echo'] })
    expect(writes.filter((line) => line.includes('READY:'))).toHaveLength(1)
    expect(writes.some((line) => line.includes('READY\\x02'))).toBe(false)

    ws.onMessage({ data: JSON.stringify({ type: 'input', data: 'echo hi' }) }, conn)
    await vi.waitFor(() => expect(sent.some((frame) => frame.type === 'output')).toBe(true))
    expect(sent.find((frame) => frame.type === 'output')?.lines).toEqual(['hi'])
    await vi.waitFor(() => expect(sent.filter((frame) => frame.type === 'prompt').length).toBeGreaterThanOrEqual(2))
    expect(sent.at(-1)).toMatchObject({ type: 'prompt', prompt: '$ ', completion: { files: ['app'] } })
    expect(listCommands).toHaveBeenCalledOnce()
    expect(listDir).toHaveBeenCalled()

    ws.onClose(undefined, conn)
    await vi.waitFor(() => expect(cleanupCommands).toHaveLength(1))
    expect(cleanupCommands[0]?.at(-1)).toBe('123')
    expect(sessions.activeCount()).toBe(0)
    expect(closed).toEqual([])
  })

  it('activeCount 为 0 且空闲达到阈值后，按容器驻留的 service 被回收', () => {
    let nowMs = 1_000_000
    const sessions = createDockerExecSessions(createOptions(() => nowMs))

    sessions.createWsEvents('a')
    sessions.createWsEvents('b')
    expect(sessions.managedCount()).toBe(2)
    expect(sessions.activeCount()).toBe(0)

    nowMs += DOCKER_EXEC_SERVICE_IDLE_MS - 1
    sessions.activeCount()
    expect(sessions.managedCount()).toBe(2)

    nowMs += 1
    sessions.createWsEvents('c')
    expect(sessions.managedCount()).toBe(1)
  })

  it('阈值内再次 createWsEvents 刷新最后使用时间，service 不被回收', () => {
    let nowMs = 0
    const sessions = createDockerExecSessions(createOptions(() => nowMs))

    sessions.createWsEvents('a')
    nowMs += DOCKER_EXEC_SERVICE_IDLE_MS - 1
    sessions.createWsEvents('a')
    nowMs += DOCKER_EXEC_SERVICE_IDLE_MS - 1
    expect(sessions.managedCount()).toBe(1)
  })
})
