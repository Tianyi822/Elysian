import { useMemo } from 'react'
import { useGateway } from '../../adapters/GatewayProvider'
import { useSilentPolling } from '../../components/agent/useSilentPolling'
import { StatusTag } from '../../components/StatusTag'
import { useAgentCapabilitiesStore } from '../../stores/agentCapabilitiesStore'
import { CapabilitiesEmptyState } from './AgentCapabilitiesPage'

/*
 * 执行器运行时面板：GET /execution-runtimes 的只读列表（id/containerId/serverId/
 * state，条目经地基 AgentExecutionRuntime 契约类型）。执行器未就绪时服务端回空
 * 数组，空态文案如实说明；页签激活期间 15 秒静默轮询，连续失败标「连接中断，
 * 正在重试」，不驱动刷新按钮。
 */

export function ExecutionRuntimesPanel() {
  const gateway = useGateway()
  const runtimes = useAgentCapabilitiesStore((state) => state.executionRuntimes)
  const refresh = useAgentCapabilitiesStore((state) => state.refreshExecutionRuntimes)

  const { degraded } = useSilentPolling(
    (signal) => refresh(gateway, signal),
    { intervalMs: 15_000, enabled: true },
  )

  const sorted = useMemo(() => [...runtimes].sort((left, right) => left.id.localeCompare(right.id)), [runtimes])

  return (
    <div className="flex flex-col gap-3">
      {degraded ? (
        <p role="status" className="text-xs text-warning">连接中断，正在重试</p>
      ) : null}
      {sorted.length === 0 ? (
        <CapabilitiesEmptyState
          title="执行器未就绪"
          description="容器执行服务尚未托管任何执行器进程；由 stdio MCP 探测启动的进程就绪后会出现在这里。"
        />
      ) : (
        <div role="region" aria-label="执行器运行时列表" className="overflow-x-auto panel-surface">
          <table className="w-full min-w-[44rem] table-fixed border-separate border-spacing-0 text-left text-sm">
            <colgroup>
              <col className="w-[18%]" />
              <col className="w-[34%]" />
              <col className="w-[26%]" />
              <col className="w-[22%]" />
            </colgroup>
            <thead>
              <tr>
                {['执行器', '容器', '来源服务', '状态'].map((label) => (
                  <th key={label} scope="col" className="border-b border-line bg-surface px-3 py-2.5 text-xs font-medium text-fg-muted">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((item) => (
                <tr key={item.id} className="transition-colors hover:bg-surface-raised/50">
                  <td className="border-b border-line px-3 py-2.5 font-mono text-xs" title={item.id}>
                    <span className="block truncate">{item.id}</span>
                  </td>
                  <td className="border-b border-line px-3 py-2.5 font-mono text-xs" title={item.containerId}>
                    <span className="block truncate">{item.containerId}</span>
                  </td>
                  <td className="border-b border-line px-3 py-2.5 font-mono text-xs" title={item.serverId ?? ''}>
                    {item.serverId === undefined ? (
                      <span className="text-fg-subtle">非探测进程</span>
                    ) : (
                      <span className="block truncate">
                        {item.serverId}
                        {item.serverRevision !== undefined ? <span className="text-fg-subtle tabular-nums"> @{item.serverRevision}</span> : null}
                      </span>
                    )}
                  </td>
                  <td className="border-b border-line px-3 py-2.5">
                    <StatusTag label={item.state === 'running' ? '运行中' : item.state === 'stopping' ? '停止中' : item.state} tone={item.state === 'running' ? 'success' : 'warning'} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
