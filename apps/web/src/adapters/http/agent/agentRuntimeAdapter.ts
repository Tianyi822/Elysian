import type { AgentRuntimeAdapter } from '../../../contracts/adapters'
import { fetchAgentRuntime } from './agentRuntimeHttp'

export function createHttpAgentRuntimeAdapter(): AgentRuntimeAdapter {
  return { runtime: (signal) => fetchAgentRuntime('/api/agent', signal) }
}
