import type { AgentRuntimeAdapter } from '../../../contracts/adapters'
import { fetchAgentRuntime } from './agentRuntimeHttp'
import { defaultAgentHttpClient } from './agentShared'

export function createHttpAgentRuntimeAdapter(client = defaultAgentHttpClient): AgentRuntimeAdapter {
  return { runtime: (signal) => fetchAgentRuntime('/api/agent', signal, client) }
}
