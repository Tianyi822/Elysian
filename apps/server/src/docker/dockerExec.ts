import { TERMINAL_COLS, TERMINAL_ROWS } from '@elysian/contracts'
import {
  TERMINAL_COMPLETION_COMMANDS_MAX,
  TERMINAL_COMPLETION_FILES_MAX,
} from '../terminals/terminalsService.ts'
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
kids=""
for statf in /proc/[0-9]*/stat; do
  [ -f "$statf" ] || continue
  p=\${statf#/proc/}; p=\${p%/stat}
  ppid=$(awk '{print $4}' "$statf" 2>/dev/null) || continue
  if [ "$ppid" = "$target" ]; then
    kids="$kids $p"
  fi
done
for pass in 1 2; do
  for p in $kids $target; do
    if [ "$pass" = 1 ]; then
      kill -HUP "$p" 2>/dev/null || true
    else
      kill -KILL "$p" 2>/dev/null || true
    fi
  done
  [ "$pass" = 1 ] && sleep 1
done`

const PID_PATTERN = /^[0-9]{1,10}$/

export type ExecRunner = {
  run(
    cmd: readonly string[],
    tty: boolean,
    env?: Readonly<Record<string, string>>,
  ): {
    write(text: string): void
    stdout: AsyncIterable<Uint8Array>
    close(): void
    exitCode?(): Promise<number>
  }
}

/** 把 exec stdout 读成一个完整字符串；探测与断开清理等「读到流结束」的路径共用。 */
export async function readStdoutText(stdout: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder()
  let text = ''
  for await (const chunk of stdout) {
    text += decoder.decode(chunk, { stream: true })
  }
  return text + decoder.decode()
}

const COMPLETION_TIMEOUT_MS = 1_000
const COMPLETION_OUTPUT_MAX_BYTES = 256 * 1024

/** 补全查询是短命 exec；用 TTY 取得无 Docker 多路复用头的文本，超时或超量就降级。 */
async function completionLines(
  exec: ExecRunner,
  command: readonly string[],
  maxItems: number,
): Promise<readonly string[]> {
  const session = exec.run(command, true)
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    session.close()
  }, COMPLETION_TIMEOUT_MS)
  timer.unref?.()
  const decoder = new TextDecoder()
  let output = ''
  let bytes = 0
  try {
    for await (const chunk of session.stdout) {
      bytes += chunk.byteLength
      if (bytes > COMPLETION_OUTPUT_MAX_BYTES) throw new Error('容器终端补全输出过大')
      output += decoder.decode(chunk, { stream: true })
    }
    if (timedOut) throw new Error('容器终端补全超时')
    output += decoder.decode()
    return [...new Set(output.split(/\r?\n/).filter((line) => line.length > 0 && !/[\x00-\x1f\x7f]/.test(line)))].slice(0, maxItems)
  } finally {
    clearTimeout(timer)
    session.close()
  }
}

/** bash 使用 compgen；sh 逐个检查 PATH 目录中的可执行普通文件。脚本不拼用户输入。 */
const SH_COMMANDS_SCRIPT = `old_ifs=$IFS; IFS=:; set -- $PATH; IFS=$old_ifs
for dir do
  [ -d "$dir" ] || continue
  for file in "$dir"/*; do
    [ -f "$file" ] && [ -x "$file" ] && printf '%s\\n' "\${file##*/}"
  done
done`

export function listDockerCommands(exec: ExecRunner, kind: 'bash' | 'sh'): Promise<readonly string[]> {
  const command = kind === 'bash'
    ? ['/bin/bash', '-c', 'compgen -A command']
    : ['/bin/sh', '-c', SH_COMMANDS_SCRIPT]
  return completionLines(exec, command, TERMINAL_COMPLETION_COMMANDS_MAX)
}

export function listDockerFiles(exec: ExecRunner, cwd: string): Promise<readonly string[]> {
  if (!cwd.startsWith('/') || /[\x00\r\n]/.test(cwd)) {
    throw new Error('容器终端工作目录无效')
  }
  // 保留第 513 项，让会话层按既有口径返回 files:null，而非误报完整清单。
  // 补全 exec 使用 TTY，ls 默认会着色；显式关闭颜色，避免 ANSI 码混进文件名。
  return completionLines(exec, ['/bin/ls', '-1A', '--color=never', '--', cwd], TERMINAL_COMPLETION_FILES_MAX + 1)
}

/** 探测容器内 bash / sh / 无 shell。 */
export async function probeShell(exec: ExecRunner, signal?: AbortSignal): Promise<'bash' | 'sh' | 'none'> {
  let session: ReturnType<ExecRunner['run']>
  try {
    session = exec.run(dockerShellProbeCommand(), false)
  } catch {
    return 'none'
  }
  const onAbort = () => session.close()
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()
  try {
    const text = await readStdoutText(session.stdout)
    if (text.includes('bash=yes')) return 'bash'
    if (text.includes('bash=no')) return 'sh'
    return 'none'
  } finally {
    signal?.removeEventListener('abort', onAbort)
    session.close()
  }
}

/**
 * 按探测结果构造容器终端的 shell 规格。printf 用 POSIX 八进制转义（\001/\002）产出
 * READY 哨兵的真实控制字节，bash/dash/busybox 的内建 printf 都支持，sh 与 bash 规格
 * 同形；READY 里的 pid 是容器内 shell 进程号，断开清理以它为目标。
 */
export function shellSpecFor(kind: 'bash' | 'sh', stty: boolean): ShellSessionSpec {
  const sttyPrefix = stty ? `stty cols ${TERMINAL_COLS} rows ${TERMINAL_ROWS} -echo; ` : ''
  if (kind === 'bash') {
    return {
      env: {
        PS1: '',
        PROMPT_COMMAND: 'printf "\\x01PWD:%s\\x02\\n" "$PWD"',
      },
      startupLine: `${sttyPrefix}set +H; printf '\\001READY:%s\\002\\n' $$\n`,
    }
  }
  return {
    // 前端绘制 `$ `，shell 的 PS1 只产出以换行结尾的 PWD 哨兵，
    // 避免输出区多出第二个提示符，也让行汇编器完整识别命令结束。
    // ash 会在每次渲染 PS1 时展开 $PWD，控制字节经 exec env 原样传入。
    env: {
      PS1: '\x01PWD:$PWD\x02\n',
    },
    startupLine: `${sttyPrefix}printf '\\001READY:%s\\002\\n' $$\n`,
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

/** 回显过滤的行缓冲上限（按字符串长度计）：无换行输出超过它时整块透传，不再等换行。 */
export const DOCKER_EXEC_ECHO_LINE_MAX_CHARS = 64 * 1024

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
        // 无换行的超长输出整块透传：不丢字节，代价是跨块的行不再参与回显抑制。
        if (pending.length > DOCKER_EXEC_ECHO_LINE_MAX_CHARS) {
          yield encoder.encode(pending)
          pending = ''
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
export function createLazyExecPty(open: (signal: AbortSignal) => Promise<PtyProcess>): PtyProcess {
  const abort = new AbortController()
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
    openPromise ??= open(abort.signal)
      .then(async (pty) => {
        if (abort.signal.aborted) {
          await pty.kill()
          throw new Error('容器终端连接已取消')
        }
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
      abort.abort()
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
  const session = exec.run(shellCommandFor(spec), true, spec.env)
  let pendingEchoLine: string | null = null
  const dropEcho = shouldDropEchoLines(spec)

  let resolveExit: (code: number) => void = () => {}
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve
  })

  session.write(spec.startupLine)

  const outputSource = dropEcho
    ? createEchoFilteredStdout(
        session.stdout,
        () => pendingEchoLine,
        () => {
          pendingEchoLine = null
        },
      )
    : session.stdout

  const stdout: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() {
      try {
        yield* outputSource
        resolveExit(session.exitCode ? await session.exitCode() : 0)
      } catch (error) {
        resolveExit(1)
        throw error
      } finally {
        session.close()
      }
    },
  }

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
