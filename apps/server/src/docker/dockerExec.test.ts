import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  cleanupScriptPid,
  createExecPty,
  DOCKER_EXEC_CLEANUP_SCRIPT,
  DOCKER_EXEC_ECHO_LINE_MAX_CHARS,
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

  it('两个分支的启动行都以八进制 printf 产出带 pid 的 READY 哨兵（sh 无 stty 也不例外）', () => {
    const printfSegment = "printf '\\001READY:%s\\002\\n' $$"
    expect(shellSpecFor('bash', true).startupLine).toContain(printfSegment)
    expect(shellSpecFor('sh', true).startupLine).toContain(printfSegment)
    expect(shellSpecFor('sh', false).startupLine).toContain(printfSegment)
  })

  it('sh 规格的 PS1 内嵌真实控制字节，PWD 哨兵不依赖 shell 转义解析', () => {
    const spec = shellSpecFor('sh', false)
    expect(spec.env.PS1).toBe('$ \x01PWD:$PWD\x02 ')
    expect(spec.env.PS1).not.toContain('\\x01')
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

describe('DOCKER_EXEC_CLEANUP_SCRIPT', () => {
  it('脚本是合法的 /bin/sh 脚本', () => {
    expect(() => execFileSync('/bin/sh', ['-n'], { input: DOCKER_EXEC_CLEANUP_SCRIPT })).not.toThrow()
  })

  it('先快照 ppid 匹配的子进程，再对 kids 与 target 两轮发信号', () => {
    const script = DOCKER_EXEC_CLEANUP_SCRIPT
    const snapshotIndex = script.indexOf('for statf in /proc/[0-9]*/stat')
    const matchIndex = script.indexOf('[ "$ppid" = "$target" ]')
    const roundsIndex = script.indexOf('for pass in 1 2')
    expect(snapshotIndex).toBeGreaterThanOrEqual(0)
    expect(matchIndex).toBeGreaterThan(snapshotIndex)
    expect(roundsIndex).toBeGreaterThan(matchIndex)
    expect(script.indexOf('kill -HUP')).toBeGreaterThan(roundsIndex)
    expect(script.indexOf('kill -KILL')).toBeGreaterThan(script.indexOf('kill -HUP'))
    expect(script).toContain('for p in $kids $target')
  })

  it('两轮信号之间等待一秒让 HUP 生效，KILL 兜底', () => {
    const script = DOCKER_EXEC_CLEANUP_SCRIPT
    const hupIndex = script.indexOf('kill -HUP')
    const killIndex = script.indexOf('kill -KILL')
    const sleepIndex = script.indexOf('sleep 1')
    // sleep 在循环体尾部：第一轮（HUP）末尾停一秒，第二轮才发 KILL。
    expect(hupIndex).toBeLessThan(killIndex)
    expect(killIndex).toBeLessThan(sleepIndex)
    expect(sleepIndex).toBeLessThan(script.length)
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

  it('无换行的超长输出按块透传，不等待换行也不丢字节', async () => {
    const spec = shellSpecFor('sh', false)
    expect(spec.startupLine).not.toContain('stty')
    const oversized = 'a'.repeat(DOCKER_EXEC_ECHO_LINE_MAX_CHARS + 1)
    const exec: ExecRunner = {
      run() {
        return {
          write: () => {},
          stdout: (async function* () {
            yield new TextEncoder().encode(oversized)
            yield new TextEncoder().encode('END\n')
          })(),
          close: () => {},
        }
      },
    }

    const pty = createExecPty(exec, spec)
    const chunks: string[] = []
    const decoder = new TextDecoder()
    for await (const chunk of pty.stdout) {
      chunks.push(decoder.decode(chunk, { stream: true }))
    }

    // 超长无换行块在下一块到达前先透传，不与后续行合并进同一次产出。
    expect(chunks[0]).toBe(oversized)
    expect(chunks.at(-1)).toBe('END\n')
  })

  it('向 ExecRunner.run 第三参传 spec.env，命令取 shellCommandFor 结果', () => {
    const spec = shellSpecFor('bash', true)
    const runs: Array<{ cmd: readonly string[]; tty: boolean; env?: Readonly<Record<string, string>> }> = []
    const exec: ExecRunner = {
      run(cmd, tty, env) {
        runs.push({ cmd, tty, env })
        return {
          write: () => {},
          stdout: (async function* () {})(),
          close: () => {},
        }
      },
    }

    createExecPty(exec, spec)

    expect(runs).toHaveLength(1)
    expect(runs[0]?.tty).toBe(true)
    expect(runs[0]?.env).toEqual(spec.env)
    expect(runs[0]?.cmd).toEqual(['/bin/bash', '--noediting'])
  })
})
