import type { AgentExecutionGrant, AgentExecutionGrantInput, AgentExecutionProfile, AgentExecutionProfileInput } from '@elysian/contracts'
import type { AgentExecutionAdapter } from '../../../contracts/agentExecution'
import { validateExecutionGrant, validateExecutionProfile } from '../../agentExecutionValidation'
import { AgentHttpError } from '../../http/agent/agentShared'

/** 每个 gateway 持有自己的修订库，编号与时钟确定；演示不访问磁盘或 Docker。 */
export class AgentExecutionMockAdapter implements AgentExecutionAdapter {
  private profiles: AgentExecutionProfile[] = []
  private grants: AgentExecutionGrant[] = []
  private sequence = 0
  private copy<T>(value: T): T { return structuredClone(value) }
  private latest<T extends { id: string; revision: number }>(items: T[]): T[] { return [...new Map(items.map(item => [item.id, item])).values()] }
  private get<T extends { id: string; revision: number }>(items: T[], id: string, revision?: number): T {
    const item = [...items].reverse().find(item => item.id === id && (revision === undefined || item.revision === revision))
    if (!item) throw new AgentHttpError('执行配置或授权修订不存在', 'execution_not_found', 404)
    return this.copy(item)
  }
  private identity<T extends { id: string; revision: number }>(items: T[], id: string | undefined, expected: number, prefix: string) {
    if (id) {
      const latest = this.get(items, id)
      if (latest.revision !== expected) throw new AgentHttpError('执行配置或授权已被修改，请重新读取后重试', 'execution_revision_conflict', 409)
      return { id, revision: expected + 1 }
    }
    if (expected !== 0) throw new AgentHttpError('新建的预期修订必须为零', 'execution_revision_conflict', 409)
    return { id: `${prefix}-${String(++this.sequence).padStart(32, '0')}`, revision: 1 }
  }
  async listProfiles() { return this.copy(this.latest(this.profiles)) }
  async getProfile(id: string, revision?: number) { return this.get(this.profiles, id, revision) }
  async createProfile(input: AgentExecutionProfileInput) { return this.saveProfile(undefined, input) }
  async updateProfile(id: string, input: AgentExecutionProfileInput) { return this.saveProfile(id, input) }
  private saveProfile(id: string | undefined, input: AgentExecutionProfileInput) {
    const errors = validateExecutionProfile(input)
    if (Object.keys(errors).length) throw new AgentHttpError(Object.values(errors)[0]!, 'execution_invalid_profile', 400)
    const { expectedRevision: _expected, id: _id, ...config } = this.copy(input)
    const item: AgentExecutionProfile = { ...config, ...this.identity(this.profiles, id, input.expectedRevision, 'profile'), name: input.name.trim(), createdAt: '2026-10-20T00:00:00Z' }
    this.profiles.push(item); return this.copy(item)
  }
  async setProfileEnabled(id: string, expectedRevision: number, enabled: boolean) { return this.updateProfile(id, { ...await this.getProfile(id), expectedRevision, enabled }) }
  async listGrants() { return this.copy(this.latest(this.grants)) }
  async getGrant(id: string, revision?: number) { return this.get(this.grants, id, revision) }
  async createGrant(input: AgentExecutionGrantInput) { return this.saveGrant(undefined, input) }
  async updateGrant(id: string, input: AgentExecutionGrantInput) { return this.saveGrant(id, input) }
  private saveGrant(id: string | undefined, input: AgentExecutionGrantInput) {
    const errors = validateExecutionGrant(input, '/srv/elysian')
    if (Object.keys(errors).length) throw new AgentHttpError(Object.values(errors)[0]!, 'execution_invalid_grant', 400)
    const { expectedRevision: _expected, id: _id, ...config } = this.copy(input)
    const item: AgentExecutionGrant = { ...config, ...this.identity(this.grants, id, input.expectedRevision, 'grant'), name: input.name.trim(), network: input.network.map(endpoint => ({ ...endpoint, host: endpoint.host.toLowerCase() })), createdAt: '2026-10-20T00:00:00Z' }
    this.grants.push(item); return this.copy(item)
  }
  async setGrantEnabled(id: string, expectedRevision: number, enabled: boolean) {
    const input = { ...await this.getGrant(id), expectedRevision, enabled }
    if (enabled) return this.updateGrant(id, input)
    const { expectedRevision: _expected, ...config } = input
    const item = { ...config, ...this.identity(this.grants, id, expectedRevision, 'grant') }
    this.grants.push(item); return this.copy(item)
  }
}
