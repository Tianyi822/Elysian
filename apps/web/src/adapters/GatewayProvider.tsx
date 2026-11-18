import { createContext, useContext, useMemo } from 'react'
import type { ReactNode } from 'react'
import type { ElysianGateway } from '../contracts/adapters'
import { createMockGateway } from './mock/gateway'
import { isDockerRuntime } from '../app/runtime/isDockerRuntime'

const GatewayContext = createContext<ElysianGateway | null>(null)

export function createDefaultGateway(docker = isDockerRuntime()): ElysianGateway {
  const mode = docker ? 'http' : 'mock'
  return createMockGateway({
    firewall: mode,
    ssh: mode,
    users: mode,
    files: mode,
    containers: mode,
    websites: mode,
    dependencies: mode,
    logs: mode,
    terminals: docker ? 'ws' : 'mock',
    session: mode,
    panel: mode,
    modelSettings: mode,
    agentRuntime: mode,
    agentExtensions: mode,
    agentMemory: mode,
  })
}

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
  const value = useMemo(() => gateway ?? createDefaultGateway(), [gateway])
  return <GatewayContext.Provider value={value}>{children}</GatewayContext.Provider>
}

export function useGateway(): ElysianGateway {
  const gateway = useContext(GatewayContext)
  if (!gateway) throw new Error('useGateway 必须在 GatewayProvider 内使用')
  return gateway
}
