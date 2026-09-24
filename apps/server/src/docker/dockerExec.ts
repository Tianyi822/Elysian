import { TERMINAL_COLS, TERMINAL_ROWS } from '@elysian/contracts'
import type { ShellSessionSpec } from '../terminals/terminalsService.ts'
import type { PtyProcess } from '../terminals/terminalsHostDeps.ts'

/** 容器 shell 探测脚本：只打印 bash 与 stty 是否可用，不拼接容器 id。 */
export const DOCKER_SHELL_PROBE_SCRIPT =
  'command -v bash >/dev/null 2>&1 && echo bash=yes || echo bash=no; stty size >/dev/null 2>&1 && echo stty=yes || echo stty=no'

/** 探测 exec 的命令数组（固定字符串，argv 形式）。 */
export function dockerShellProbeCommand(): readonly string[] {
  return ['/bin/sh', '-c', DOCKER_SHELL_PROBE_SCRIPT]
}

/** exec 断开后的清理脚本（pid 经 `--` 传入，不得写进脚本字符串）。 */
export const DOCKER_EXEC_CLEANUP_SCRIPT = `set -eu
target=$1
for pass in 1 2; do
  for statf in /proc/[0-9]*/stat; do
    [ -f "$statf" ] || continue
    p=\${statf#/proc/}; p=\${p%/stat}
    ppid=$(awk '{print $4}' "$statf" 2>/dev/null) || continue
    if [ "$p" = "$target" ] || [ "$ppid" = "$target" ]; then
      if [ "$pass" = 1 ]; then
        kill -HUP "$p" 2>/dev/null || true
      else
        kill -KILL "$p" 2>/dev/null || true
      fi
    fi
  done
  [ "$pass" = 1 ] && sleep 1
done`

const PID_PATTERN = /^[0-9]{1,10}$/

export type ExecRunner = {
  run(
    cmd: readonly string[],
    tty: boolean,
  ): {
    write(text: string): void
    stdout: AsyncIterable<Uint8Array>
    close(): void
  }
}

async function readStdoutText(stdout: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder()
  let text = ''
  for await (const chunk of stdout) {
    text += decoder.decode(chunk, { stream: true })
  }
  return text + decoder.decode()
}

/** 探测容器内 bash / sh / 无 shell。 */
export async function probeShell(exec: ExecRunner): Promise<'bash' | 'sh' | 'none'> {
  let session: ReturnType<ExecRunner['run']>
  try {
    session = exec.run(dockerShellProbeCommand(), false)
  } catch {
    return 'none'
  }
  try {
    const text = await readStdoutText(session.stdout)
    if (text.includes('bash=yes')) return 'bash'
    if (text.includes('bash=no')) return 'sh'
    return 'none'
  } finally {
    session.close()
  }
}

/** 按探测结果构造容器终端的 shell 规格。 */
export function shellSpecFor(kind: 'bash' | 'sh', stty: boolean): ShellSessionSpec {
  const sttyPrefix = stty ? `stty cols ${TERMINAL_COLS} rows ${TERMINAL_ROWS} -echo; ` : ''
  if (kind === 'bash') {
    return {
      env: {
        PS1: '',
        PROMPT_COMMAND: 'printf "\\x01PWD:%s\\x02\\n" "$PWD"',
      },
      startupLine: `${sttyPrefix}set +H; printf '\\x01READY:%s\\x02\\n' $$\n`,
    }
  }
  return {
    env: {
      PS1: '$ \\x01PWD:$PWD\\x02 ',
    },
    startupLine: stty ? `${sttyPrefix}\n` : '',
  }
}

/** 构造断开清理 exec 的命令数组；pid 只作位置参数。 */
export function cleanupScriptPid(pid: string): readonly string[] {
  if (!PID_PATTERN.test(pid)) {
    throw new Error('清理脚本的 pid 必须是 1 到 10 位数字')
  }
  return ['/bin/sh', '-c', DOCKER_EXEC_CLEANUP_SCRIPT, '--', pid]
}

function shellCommandFor(spec: ShellSessionSpec): readonly string[] {
  return spec.startupLine.includes('set +H') ? ['/bin/bash', '--noediting'] : ['/bin/sh']
}

function shouldDropEchoLines(spec: ShellSessionSpec): boolean {
  return !spec.startupLine.includes('stty')
}

function createEchoFilteredStdout(
  source: AsyncIterable<Uint8Array>,
  getPendingEchoLine: () => string | null,
  clearPendingEchoLine: () => void,
): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  let pending = ''
  return {
    async *[Symbol.asyncIterator]() {
      for await (const chunk of source) {
        pending += decoder.decode(chunk, { stream: true })
        let newlineIndex = pending.indexOf('\n')
        while (newlineIndex !== -1) {
          const line = pending.slice(0, newlineIndex)
          pending = pending.slice(newlineIndex + 1)
          const echoLine = getPendingEchoLine()
          if (echoLine !== null && line === echoLine) {
            clearPendingEchoLine()
          } else {
            yield encoder.encode(`${line}\n`)
          }
          newlineIndex = pending.indexOf('\n')
        }
      }
      const tail = decoder.decode()
      if (tail !== '') pending += tail
      if (pending !== '') {
        const echoLine = getPendingEchoLine()
        if (echoLine !== null && pending === echoLine) {
          clearPendingEchoLine()
        } else {
          yield encoder.encode(pending)
        }
      }
    },
  }
}

/** 异步打开 PTY 后再暴露 write/stdout（probe 与 exec 创建在会话 start 阶段完成）。 */
export function createLazyExecPty(open: () => Promise<PtyProcess>): PtyProcess {
  let inner: PtyProcess | null = null
  let openError: Error | null = null
  let openPromise: Promise<PtyProcess> | null = null
  let resolveExited: (code: number) => void = () => {}
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve
  })

  const ensure = (): Promise<PtyProcess> => {
    if (inner) return Promise.resolve(inner)
    if (openError) return Promise.reject(openError)
    openPromise ??= open()
      .then((pty) => {
        inner = pty
        void pty.exited.then((code) => {
          resolveExited(code)
        })
        return pty
      })
      .catch((error) => {
        openError = error instanceof Error ? error : new Error(String(error))
        resolveExited(1)
        throw openError
      })
    return openPromise
  }

  const stdout: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() {
      const pty = await ensure()
      yield* pty.stdout
    },
  }

  return {
    write(text: string) {
      void ensure()
        .then((pty) => pty.write(text))
        .catch(() => undefined)
    },
    flush() {
      void ensure()
        .then((pty) => pty.flush())
        .catch(() => undefined)
    },
    stdout,
    kill: async () => {
      if (!inner) {
        resolveExited(0)
        return 0
      }
      const code = await inner.kill()
      resolveExited(code)
      return code
    },
    exited,
  }
}

/** 把 Docker exec 劫持连接包装成与会话层一致的 PtyProcess。 */
export function createExecPty(exec: ExecRunner, spec: ShellSessionSpec): PtyProcess {
  const session = exec.run(shellCommandFor(spec), true)
  let pendingEchoLine: string | null = null
  const dropEcho = shouldDropEchoLines(spec)

  let resolveExit: (code: number) => void = () => {}
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve
  })

  session.write(spec.startupLine)

  const stdout = dropEcho
    ? createEchoFilteredStdout(
        session.stdout,
        () => pendingEchoLine,
        () => {
          pendingEchoLine = null
        },
      )
    : session.stdout

  return {
    write(text: string) {
      if (dropEcho && text.endsWith('\n') && text !== spec.startupLine) {
        pendingEchoLine = text.slice(0, -1)
      }
      session.write(text)
    },
    flush: () => {},
    stdout,
    kill: async () => {
      session.close()
      resolveExit(0)
      return 0
    },
    exited,
  }
}
