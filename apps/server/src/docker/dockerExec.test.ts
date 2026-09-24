import { describe, expect, it } from 'vitest'
import {
  cleanupScriptPid,
  createExecPty,
  dockerShellProbeCommand,
  DOCKER_SHELL_PROBE_SCRIPT,
  type ExecRunner,
  probeShell,
  shellSpecFor,
} from './dockerExec.ts'

function createExecRunner(handlers: {
  onRun?: (cmd: readonly string[], tty: boolean) => void
  stdoutText?: string
  runThrows?: boolean
}): ExecRunner {
  return {
    run(cmd, tty) {
      handlers.onRun?.(cmd, tty)
      if (handlers.runThrows) {
        throw new Error('创建 exec 失败')
      }
      const stdoutText = handlers.stdoutText
      const stdout: AsyncIterable<Uint8Array> = {
        async *[Symbol.asyncIterator]() {
          if (stdoutText !== undefined) {
            yield new TextEncoder().encode(stdoutText)
          }
        },
      }
      return {
        write: () => {},
        stdout,
        close: () => {},
      }
    },
  }
}

describe('dockerShellProbeCommand', () => {
  it('使用固定探测脚本，命令以 /bin/sh 与 -c 开头', () => {
    const cmd = dockerShellProbeCommand()
    expect(cmd[0]).toBe('/bin/sh')
    expect(cmd[1]).toBe('-c')
    expect(cmd[2]).toBe(DOCKER_SHELL_PROBE_SCRIPT)
  })
})

describe('probeShell', () => {
  it('stdout 含 bash=yes 时返回 bash', async () => {
    const exec = createExecRunner({ stdoutText: 'bash=yes\nstty=yes\n' })
    await expect(probeShell(exec)).resolves.toBe('bash')
  })

  it('仅有 bash=no 且 exec 可创建时返回 sh', async () => {
    const exec = createExecRunner({ stdoutText: 'bash=no\nstty=no\n' })
    await expect(probeShell(exec)).resolves.toBe('sh')
  })

  it('创建 exec 失败时返回 none', async () => {
    const exec = createExecRunner({ runThrows: true })
    await expect(probeShell(exec)).resolves.toBe('none')
  })
})

describe('shellSpecFor', () => {
  it('bash 规格的启动行含 READY: 与 $$', () => {
    const spec = shellSpecFor('bash', true)
    expect(spec.startupLine).toContain('READY:')
    expect(spec.startupLine).toContain('$$')
  })

  it('sh 规格的 PS1 含 $PWD', () => {
    const spec = shellSpecFor('sh', false)
    expect(spec.env.PS1).toContain('$PWD')
  })
})

describe('cleanupScriptPid', () => {
  it('最后一项为 pid，脚本字符串不含 pid 字面量', () => {
    const cmd = cleanupScriptPid('12')
    expect(cmd[0]).toBe('/bin/sh')
    expect(cmd[1]).toBe('-c')
    expect(cmd.at(-1)).toBe('12')
    expect(cmd[2]).not.toContain('12')
  })

  it('非法 pid 抛错', () => {
    expect(() => cleanupScriptPid('12;rm')).toThrow()
  })
})

describe('createExecPty', () => {
  it('无 stty 时丢弃与输入相同的第一行回显', async () => {
    const spec = shellSpecFor('sh', false)
    expect(spec.startupLine).not.toContain('stty')

    const exec: ExecRunner = {
      run(_cmd, tty) {
        expect(tty).toBe(true)
        const chunks: Uint8Array[] = []
        const wakers: (() => void)[] = []
        let closed = false
        const push = (text: string) => {
          chunks.push(new TextEncoder().encode(text))
          for (const wake of wakers.splice(0)) wake()
        }
        const iterator = {
          next: (): Promise<IteratorResult<Uint8Array>> => {
            const chunk = chunks.shift()
            if (chunk !== undefined) return Promise.resolve({ value: chunk, done: false })
            if (closed) return Promise.resolve({ value: undefined, done: true })
            return new Promise((resolve) => {
              wakers.push(() => void iterator.next().then(resolve))
            })
          },
        }
        return {
          write(text: string) {
            if (text === 'echo hi\n') {
              push('echo hi\nhi\n')
              closed = true
              for (const wake of wakers.splice(0)) wake()
            }
          },
          stdout: { [Symbol.asyncIterator]: () => iterator },
          close: () => {
            closed = true
            for (const wake of wakers.splice(0)) wake()
          },
        }
      },
    }

    const pty = createExecPty(exec, spec)
    const collected: string[] = []
    const pump = (async () => {
      const dec = new TextDecoder()
      let pending = ''
      for await (const chunk of pty.stdout) {
        pending += dec.decode(chunk, { stream: true })
        let idx = pending.indexOf('\n')
        while (idx !== -1) {
          collected.push(pending.slice(0, idx))
          pending = pending.slice(idx + 1)
          idx = pending.indexOf('\n')
        }
      }
      if (pending !== '') collected.push(pending)
    })()

    pty.write('echo hi\n')
    await pump

    expect(collected).toEqual(['hi'])
  })
})
