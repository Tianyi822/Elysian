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
        // 防火墙、SSH、主机账号、文件管理、容器列表、网站管理与日志端点只在容器内的
        // dev/preview 中间件挂载；宿主机本地开发走内存演示。
        // 数据库域固定走 HTTP adapter（/api/databases），不做本地 mock 分流。
        firewall: isDockerRuntime() ? 'http' : 'mock',
        ssh: isDockerRuntime() ? 'http' : 'mock',
        users: isDockerRuntime() ? 'http' : 'mock',
        files: isDockerRuntime() ? 'http' : 'mock',
        containers: isDockerRuntime() ? 'http' : 'mock',
        // 网站在 Docker 运行时经 /api/websites 落真实容器、站点目录与宿主 Caddy 配置。
        websites: isDockerRuntime() ? 'http' : 'mock',
        // 依赖检测在 Docker 运行时接 /api/platform/dependencies 现场探测宿主
        // Docker 与 Caddy 通道；本地开发恒双 ok，不弹安装引导。
        dependencies: isDockerRuntime() ? 'http' : 'mock',
        // 日志的 http 分支只影响运行与操作两类；登录日志没有真实端点，两种取值下都读内存演示。
        logs: isDockerRuntime() ? 'http' : 'mock',
        terminals: isDockerRuntime() ? 'ws' : 'mock',
        // 会话在 Docker 运行时经 /api/auth 走真实登录（requireSession 读写全挡）；
        // 本地无后端演示不强制登录。
        session: isDockerRuntime() ? 'http' : 'mock',
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
