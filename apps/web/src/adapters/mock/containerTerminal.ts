import type { Container, ContainerImage } from '@elysian/contracts'
import { DATASET_BASE_TIME } from './dataset'
import { INITIAL_CONTAINER_USAGE } from './containersData'
import { formatUptime } from './containerViews'

/**
 * 演示终端的命令引擎：纯函数、确定性输出、与容器 mock 数据联动。
 * 不执行任何真实 Shell，未知命令如实说明。
 */

export type TerminalResult = { lines: readonly string[]; clear?: boolean }

const HELP_LINE =
  '可用命令：help、ls、env、ps、cat /etc/os-release、uptime、df -h、top、clear'

/** Tab 补全的词表：命令本身，以及带固定参数的命令的参数候选。 */
export const TERMINAL_COMMANDS = [
  'help',
  'ls',
  'env',
  'ps',
  'cat',
  'uptime',
  'df',
  'top',
  'clear',
] as const

const ARG_CANDIDATES: Record<string, readonly string[]> = {
  cat: ['/etc/os-release'],
  df: ['-h'],
}

export type CompletionResult = {
  draft: string
  cursor: number
  /** 多个候选且无法再收敛时给出，由界面按 bash 的习惯列出行。 */
  candidates?: readonly string[]
}

/** 光标所在词的前缀补全；无可补内容时原样返回。 */
export function completeTerminalCommand(draft: string, cursor: number): CompletionResult {
  const before = draft.slice(0, cursor)
  const token = /(\S*)$/.exec(before)?.[0] ?? ''
  const tokenStart = cursor - token.length
  const previousWord = before
    .slice(0, tokenStart)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .pop()
  const pool: readonly string[] = previousWord
    ? (ARG_CANDIDATES[previousWord] ?? [])
    : TERMINAL_COMMANDS
  const matches = pool.filter((candidate) => candidate.startsWith(token))

  if (matches.length === 0) return { draft, cursor }

  if (matches.length === 1) {
    const completed = `${matches[0]} `
    return {
      draft: before.slice(0, tokenStart) + completed + draft.slice(cursor),
      cursor: tokenStart + completed.length,
    }
  }

  const common = matches.reduce((acc, candidate) => {
    let i = 0
    while (i < acc.length && i < candidate.length && acc[i] === candidate[i]) i += 1
    return acc.slice(0, i)
  }, matches[0] ?? '')

  if (common.length > token.length) {
    return {
      draft: before.slice(0, tokenStart) + common + draft.slice(cursor),
      cursor: tokenStart + common.length,
    }
  }

  return { draft, cursor, candidates: matches }
}

const DF_LINES = [
  'Filesystem      Size  Used Avail Use% Mounted on',
  '/dev/sda1        80G   38G   42G  47% /',
  '/dev/sdb1       200G  142G   58G  71% /srv/elysian',
] as const

export function execContainerCommand(
  container: Container,
  image: ContainerImage,
  command: string,
): TerminalResult {
  switch (command.trim()) {
    case 'help':
      return { lines: [HELP_LINE] }
    case 'ls':
      return {
        lines: container.volumes.length
          ? container.volumes.map((v) => v.containerPath)
          : ['(空)'],
      }
    case 'env':
      return {
        lines: container.env.length
          ? container.env.map((pair) => `${pair.key}=${pair.value}`)
          : ['(无环境变量)'],
      }
    case 'ps':
      return { lines: ['PID  CMD', `   1  ${container.command}`] }
    case 'cat /etc/os-release':
      return {
        lines: [
          `NAME="${image.name}"`,
          `VERSION="${image.tag}"`,
          `PRETTY_NAME="${image.name}:${image.tag}"`,
        ],
      }
    case 'uptime': {
      const up = formatUptime(container.startedAt, new Date(DATASET_BASE_TIME))
      return { lines: [`up ${up},  load average: 0.42 0.38 0.35`] }
    }
    case 'df -h':
      return { lines: [...DF_LINES] }
    case 'top': {
      const usage = INITIAL_CONTAINER_USAGE[container.id] ?? { cpuPercent: 0, memMb: 0 }
      return {
        lines: [
          `Tasks: 3 total, 1 running`,
          `CPU: ${usage.cpuPercent}%  内存: ${usage.memMb} MB`,
        ],
      }
    }
    case 'clear':
      return { lines: [], clear: true }
    default:
      return { lines: ['演示终端：该命令不在演示集内，输入 help 查看可用命令'] }
  }
}
