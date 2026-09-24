import type { ContainerAction } from '@elysian/contracts'

/** 容器页 SSE 断线重连时的固定提示（与 brief 逐字一致）。 */
export const CONTAINER_LIVE_RECONNECT_MESSAGE = '实时数据连接中断，正在重连…'

/** 启停成功通知：Docker 运行时去掉 mock 标注，测试可注入 docker 而不依赖 Vite env。 */
export function containerActionSuccessMessage(
  action: ContainerAction,
  name: string,
  dockerRuntime: boolean,
): string {
  if (action === 'restart') {
    return dockerRuntime ? `已请求重启 ${name}` : `已请求重启 ${name}（mock，待接入真实执行）`
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
