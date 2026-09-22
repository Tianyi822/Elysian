import { completeWithPools, type TerminalCompletion } from '../../components/terminal/terminalSession'
import type { MockCommandResult } from '../../contracts/adapters'

/**
 * 本机演示终端的命令引擎：纯函数、确定性输出，不执行任何真实 Shell。
 * 会话面向工作台管理的这台主机，用户固定为种子账号 ops。
 */

export const HOST_USER = 'ops'
export const HOST_LABEL = 'elysian-demo'
export const HOST_PROMPT = `${HOST_USER}@${HOST_LABEL}:~$ `

export type HostCommandResult = MockCommandResult

const HELP_LINE =
  '可用命令：help、whoami、hostname、pwd、ls、id、uname -a、df -h、uptime、clear'

export const HOST_TERMINAL_COMMANDS = [
  'help',
  'whoami',
  'hostname',
  'pwd',
  'ls',
  'id',
  'uname',
  'df',
  'uptime',
  'clear',
] as const

const ARG_CANDIDATES: Record<string, readonly string[]> = {
  df: ['-h'],
  uname: ['-a'],
}

const LS_ENTRIES = ['.ssh', 'Documents', 'Downloads'] as const

const DF_LINES = [
  'Filesystem      Size  Used Avail Use% Mounted on',
  '/dev/sda1        80G   38G   42G  47% /',
  '/dev/sdb1       200G  142G   58G  71% /srv/elysian',
] as const

const UNAME_LINE =
  `Linux ${HOST_LABEL} 6.8.0-elysian #1 SMP PREEMPT_DYNAMIC x86_64 GNU/Linux`

const UPTIME_LINE = 'up 42 days,  4:18,  1 user,  load average: 0.12 0.18 0.21'

const ID_LINE = `uid=1000(${HOST_USER}) gid=1000(${HOST_USER}) groups=1000(${HOST_USER}),27(sudo)`

/**
 * 光标所在词的前缀补全；无可补内容时原样返回。
 * 收敛算法在 terminalSession 的 completeWithPools（与真实 WS 适配器共用），
 * 这里只决定词表：首词用命令集，行中词按前一命令查参数候选。
 */
export function completeHostTerminalCommand(draft: string, cursor: number): TerminalCompletion {
  const before = draft.slice(0, cursor)
  const tokenStart = cursor - ((/(\S*)$/.exec(before)?.[0] ?? '').length)
  const previousWord = before
    .slice(0, tokenStart)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .pop()
  return completeWithPools(draft, cursor, {
    commands: HOST_TERMINAL_COMMANDS,
    words: previousWord ? (ARG_CANDIDATES[previousWord] ?? []) : [],
  })
}

export function execHostCommand(command: string): HostCommandResult {
  switch (command.trim()) {
    case 'help':
      return { lines: [HELP_LINE] }
    case 'whoami':
      return { lines: [HOST_USER] }
    case 'hostname':
      return { lines: [HOST_LABEL] }
    case 'pwd':
      return { lines: [`/home/${HOST_USER}`] }
    case 'ls':
      return { lines: [...LS_ENTRIES] }
    case 'id':
      return { lines: [ID_LINE] }
    case 'uname -a':
      return { lines: [UNAME_LINE] }
    case 'df -h':
      return { lines: [...DF_LINES] }
    case 'uptime':
      return { lines: [UPTIME_LINE] }
    case 'clear':
      return { lines: [], clear: true }
    default:
      return { lines: ['演示终端：该命令不在演示集内，输入 help 查看可用命令'] }
  }
}
