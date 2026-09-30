import { describe, expect, it, vi } from 'vitest'
import type { DockerTransport } from '../docker/dockerTransport.ts'
import { createHostCommandRunner, HostCommandError } from './hostShell.ts'
import { SETUP_FAILURE_ENGINE, SETUP_FAILURE_TIMEOUT } from './dependencySetupScripts.ts'

function connectionError(path: string): Error {
  const error = new Error(`connect ENOENT ${path}`) as NodeJS.ErrnoException
  error.code = 'ENOENT'
  return error
}

describe('createHostCommandRunner', () => {
  it('不在容器内时用固定环境执行 /bin/sh，不把进程环境传进去', async () => {
    const previous = process.env.ELYSIAN_SECRET
    process.env.ELYSIAN_SECRET = 'hunter2'
    const execFile = vi.fn(async (
      _file: string,
      _args: readonly string[],
      _options: { timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv; encoding: 'utf8' },
    ) => ({ stdout: 'ELYSIAN_DONE\n', stderr: '' }))
    try {
      const runner = createHostCommandRunner({ inContainer: false, execFile })
      const result = await runner.run('echo hi', 1000)
      expect(result).toEqual({ code: 0, output: 'ELYSIAN_DONE\n\n' })
      expect(execFile).toHaveBeenCalledWith('/bin/sh', ['-c', 'echo hi'], expect.objectContaining({
        timeout: 1000,
        encoding: 'utf8',
      }))
      const options = execFile.mock.calls[0]?.[2]
      expect(options?.env).not.toHaveProperty('ELYSIAN_SECRET')
      expect(options?.env?.PATH).toContain('/usr/bin')
    } finally {
      if (previous === undefined) delete process.env.ELYSIAN_SECRET
      else process.env.ELYSIAN_SECRET = previous
    }
  })

  it('本机命令非零退出时带回输出，超时变成固定中文', async () => {
    const failed = Object.assign(new Error('fail'), { code: 42, stdout: '', stderr: 'E: no\n' })
    const execFile = vi.fn()
      .mockRejectedValueOnce(failed)
      .mockRejectedValueOnce(Object.assign(new Error('timeout'), { killed: true }))
    const runner = createHostCommandRunner({ inContainer: false, execFile })
    await expect(runner.run('apt', 1000)).resolves.toEqual({ code: 42, output: '\nE: no\n' })
    await expect(runner.run('apt', 1000)).rejects.toEqual(expect.objectContaining({
      name: 'HostCommandError',
      message: SETUP_FAILURE_TIMEOUT,
    }))
  })

  it('容器内经一次性特权容器进宿主，连不上引擎时不透传 socket 路径', async () => {
    const transport: DockerTransport = {
      request: async () => {
        throw connectionError('/secret/sock')
      },
    }
    const runner = createHostCommandRunner({
      inContainer: true,
      createTransport: () => transport,
    })
    await expect(runner.run('echo hi', 1000)).rejects.toBeInstanceOf(HostCommandError)
    await expect(runner.run('echo hi', 1000)).rejects.toMatchObject({ message: SETUP_FAILURE_ENGINE })
  })

  it('镜像已在时创建 nsenter 容器，跑完删除；退出码与日志原样返回', async () => {
    const calls: string[] = []
    const transport: DockerTransport = {
      async request(input) {
        calls.push(`${input.method} ${input.path}`)
        if (input.path.includes('/images/')) return { status: 200, json: { Id: 'img' } }
        if (input.path.includes('/containers/create')) {
          expect(input.body).toMatchObject({
            Image: 'alpine:3.20',
            Entrypoint: ['nsenter', '-t', '1', '-m', '-u', '-i', '-n', '-p', '--', '/bin/sh', '-c'],
            Cmd: ['echo hi'],
            HostConfig: { Privileged: true, PidMode: 'host', NetworkMode: 'host' },
          })
          return { status: 201, json: { Id: 'a'.repeat(64) } }
        }
        if (input.path.endsWith('/start')) return { status: 204, json: null }
        if (input.path.endsWith('/wait')) return { status: 200, json: { StatusCode: 0 } }
        if (input.method === 'DELETE') return { status: 204, json: null }
        throw new Error(`unexpected ${input.method} ${input.path}`)
      },
      async pullCreate(input) {
        calls.push(`LOG ${input.path}`)
        return { status: 200, chunks: [new TextEncoder().encode('ELYSIAN_DONE\n')] }
      },
    }
    const runner = createHostCommandRunner({ inContainer: true, createTransport: () => transport })
    await expect(runner.run('echo hi', 5000)).resolves.toEqual({ code: 0, output: 'ELYSIAN_DONE\n' })
    expect(calls.some((call) => call.startsWith('DELETE '))).toBe(true)
    expect(calls.some((call) => call.includes('/images/create'))).toBe(false)
  })
})
