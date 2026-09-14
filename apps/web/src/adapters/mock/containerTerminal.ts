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
