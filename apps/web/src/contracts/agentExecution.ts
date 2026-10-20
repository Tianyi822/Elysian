import type { AgentCapability, AgentExecutionGrant, AgentExecutionGrantInput, AgentExecutionProfile, AgentExecutionProfileInput } from '@elysian/contracts'

export interface AgentExecutionAdapter {
  listProfiles(signal?: AbortSignal): Promise<readonly AgentExecutionProfile[]>
  getProfile(id: string, revision?: number, signal?: AbortSignal): Promise<AgentExecutionProfile>
  createProfile(input: AgentExecutionProfileInput): Promise<AgentExecutionProfile>
  updateProfile(id: string, input: AgentExecutionProfileInput): Promise<AgentExecutionProfile>
  setProfileEnabled(id: string, expectedRevision: number, enabled: boolean): Promise<AgentExecutionProfile>
  listGrants(signal?: AbortSignal): Promise<readonly AgentExecutionGrant[]>
  getGrant(id: string, revision?: number, signal?: AbortSignal): Promise<AgentExecutionGrant>
  createGrant(input: AgentExecutionGrantInput): Promise<AgentExecutionGrant>
  updateGrant(id: string, input: AgentExecutionGrantInput): Promise<AgentExecutionGrant>
  setGrantEnabled(id: string, expectedRevision: number, enabled: boolean): Promise<AgentExecutionGrant>
}

/** 工具目录的可用性是展示事实，不能仅凭已登记就宣称可执行。 */
export type AgentToolCatalogEntry = AgentCapability & { available?: boolean; selected?: boolean; reason?: string }
