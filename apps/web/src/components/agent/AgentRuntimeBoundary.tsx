import type { ReactNode } from 'react'
import { useAgentRuntimeStore } from '../../stores/agentRuntimeStore'
import { AgentUnavailableState } from './AgentUnavailableState'

/** 内核级 503 即刻停止页面操作；顶栏的运行时轮询仍可在恢复后解除遮挡。 */
export function AgentRuntimeBoundary({ children }: { children: ReactNode }) {
  const reason = useAgentRuntimeStore((state) => state.unavailableReason)
  return reason === undefined ? children : <AgentUnavailableState reason={reason} />
}
