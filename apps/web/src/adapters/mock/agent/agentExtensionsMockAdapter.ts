import type {
  AgentMCPServerInput,
  AgentSkillImportInput,
  AgentUpdateMCPServerInput,
} from '@elysian/contracts'
import type { AgentExtensionsAdapter } from '../../../contracts/adapters'
import { agentExtensionsDemo } from './agentExtensionsData'

/*
 * 技能与 MCP 域 mock 适配器：全部操作落在 agentExtensionsData 的确定性演示
 * 状态机上，语义与服务端 extensions_routes.go 对齐（导入异步推进、requestId
 * 幂等与 409 冲突、修订 CAS、取消与终态记录删除、probe 与固定目录、凭据与
 * 环境变量只写不回显）。resetAgentExtensionsData 维持地基同名导出
 * （apps/web/src/test/agentTestUtils.ts 从本文件聚合引用）。
 */

export { resetAgentExtensionsData } from './agentExtensionsData'

export class AgentExtensionsMockAdapter implements AgentExtensionsAdapter {
  async listSkills() {
    return agentExtensionsDemo.listSkills()
  }

  async getSkill(skillId: string, revision?: number) {
    return agentExtensionsDemo.getSkill(skillId, revision)
  }

  async getSkillFile(skillId: string, revision: number, path: string) {
    return agentExtensionsDemo.getSkillFile(skillId, revision, path)
  }

  async listCapabilityRevocations(query?: Parameters<AgentExtensionsAdapter['listCapabilityRevocations']>[0]) {
    return agentExtensionsDemo.listRevocations(query)
  }

  async setSkillEnabled(skillId: string, expectedRevision: number, enabled: boolean) {
    return agentExtensionsDemo.setSkillEnabled(skillId, expectedRevision, enabled)
  }

  async deleteSkill(skillId: string, revision: number) {
    agentExtensionsDemo.deleteSkill(skillId, revision)
  }

  async listSkillImports(query?: { cursor?: string; limit?: number }) {
    return agentExtensionsDemo.listImports(query?.cursor ?? '', query?.limit ?? 0)
  }

  async createSkillImport(input: AgentSkillImportInput, archive?: Blob) {
    const { task } = await agentExtensionsDemo.startImport(input, archive)
    return task
  }

  async getSkillImport(importId: string) {
    return agentExtensionsDemo.getImport(importId)
  }

  async cancelSkillImport(importId: string) {
    return agentExtensionsDemo.cancelImport(importId)
  }

  async deleteSkillImportRecord(importId: string) {
    agentExtensionsDemo.deleteImport(importId)
  }

  async listMcpServers() {
    return agentExtensionsDemo.listServers()
  }

  async createMcpServer(input: AgentMCPServerInput) {
    return agentExtensionsDemo.createServer(input)
  }

  async getMcpServer(serverId: string, revision: number) {
    return agentExtensionsDemo.getServer(serverId, revision)
  }

  async updateMcpServer(serverId: string, input: AgentUpdateMCPServerInput) {
    return agentExtensionsDemo.updateServer(serverId, input.expectedRevision, input)
  }

  async probeMcpServer(serverId: string, revision: number) {
    return agentExtensionsDemo.probe(serverId, revision)
  }

  async getMcpCatalog(serverId: string, revision: number, digest?: string) {
    return agentExtensionsDemo.catalog(serverId, revision, digest ?? '')
  }
}
