import type { Container, ContainerAction } from '@elysian/contracts'
import { demoNoticeSuffix, MOCK_ACTION_NOTE } from './demoNotice'

/** 容器页 SSE 断线重连时的固定提示（与 brief 逐字一致）。 */
export const CONTAINER_LIVE_RECONNECT_MESSAGE = '实时数据连接中断，正在重连…'

/** 容器终端连接中断的兜底文案：容器域措辞，经 hostTerminalCloseMessage 的可选兜底参数传入。 */
export const CONTAINER_TERMINAL_CLOSE_FALLBACK = '容器终端连接中断'

export function containerRemoveBlockedReason(container: Container, busy: boolean): string | undefined {
  if (container.removeBlockedReason) return container.removeBlockedReason
  if (container.status === 'running') return '容器正在运行，请先停止再删除'
  if (container.status === 'restarting') return '容器正在重启，无法删除'
  if (container.status === 'paused') return '容器已暂停，须停止后才能删除'
  if (busy) return '该容器正在执行其他操作'
}

/** 启停成功通知：Docker 运行时去掉 mock 标注，测试可注入 docker 而不依赖 Vite env。 */
export function containerActionSuccessMessage(
  action: ContainerAction,
  name: string,
  dockerRuntime: boolean,
): string {
  if (action === 'restart') {
    return `已请求重启 ${name}${demoNoticeSuffix(dockerRuntime, MOCK_ACTION_NOTE)}`
  }
  if (action === 'stop') {
    return `容器 ${name} 已停止`
  }
  return `容器 ${name} 已启动`
}

export function containerStopConfirmDescription(dockerRuntime: boolean): string {
  if (dockerRuntime) {
    return '停止后容器内的进程会收到 SIGTERM，10 秒内未退出则被强制结束。已发布的端口会释放，容器可再次启动。'
  }
  return '停止后容器内的服务会中断，可再次启动恢复。操作作用于演示数据，不会影响真实环境。'
}

export function containerRestartConfirmDescription(dockerRuntime: boolean): string {
  if (dockerRuntime) {
    return '重启期间容器内的服务会中断，完成后自动回到运行中。'
  }
  return '重启期间服务会短暂不可用。操作作用于演示数据，不会影响真实环境。'
}
