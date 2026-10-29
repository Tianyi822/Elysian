import type { AgentMemoryAdapter } from '../contracts/agentMemory'
import { AgentMemoryMockAdapter } from '../adapters/mock/agent/agentMemoryMockAdapter'

export function memoryFixture(api: AgentMemoryAdapter): AgentMemoryMockAdapter {
  if (!(api instanceof AgentMemoryMockAdapter)) throw new Error('测试需要 Wiki 内存 adapter')
  return api
}
