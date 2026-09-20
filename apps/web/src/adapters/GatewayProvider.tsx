import { createContext, useContext, useMemo } from 'react'
import type { ReactNode } from 'react'
import type { ElysianGateway } from '../contracts/adapters'
import { createMockGateway } from './mock/gateway'
import { isDockerRuntime } from '../app/runtime/isDockerRuntime'

const GatewayContext = createContext<ElysianGateway | null>(null)

/**
 * 适配层的注入点。真实接线时只需换掉传进来的 gateway，
 * 页面、store 与组件都不用改——这是整个前端唯一的测试接缝。
 */
export function GatewayProvider({
  children,
  gateway,
}: {
  children: ReactNode
  gateway?: ElysianGateway
}) {
  const value = useMemo(
    () =>
      gateway ??
      createMockGateway({
        // 防火墙、SSH 与主机账号端点只在容器内的 dev/preview 中间件挂载；宿主机本地开发走内存演示。
        firewall: isDockerRuntime() ? 'http' : 'mock',
        ssh: isDockerRuntime() ? 'http' : 'mock',
        users: isDockerRuntime() ? 'http' : 'mock',
      }),
    [gateway],
  )
  return <GatewayContext.Provider value={value}>{children}</GatewayContext.Provider>
}

export function useGateway(): ElysianGateway {
  const gateway = useContext(GatewayContext)
  if (!gateway) throw new Error('useGateway 必须在 GatewayProvider 内使用')
  return gateway
}
