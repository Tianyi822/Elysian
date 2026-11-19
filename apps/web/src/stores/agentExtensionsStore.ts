import { create } from 'zustand'
import { createAgentExtensionImports, type AgentExtensionImportsState } from './agentExtensionImports'
import { createAgentExtensionMcp, type AgentExtensionMcpState } from './agentExtensionMcp'
import { createAgentExtensionSkills, type AgentExtensionSkillsState } from './agentExtensionSkills'

/*
 * 技能与 MCP 域界面状态。数据一律经 gateway.agentExtensions 的 adapter 取，
 * 组件不碰数据来源。三个切片各自承担六态：技能目录、导入任务分页、MCP 服务与
 * 探测/固定目录。静默轮询只刷数据不驱动刷新按钮；导入任务由非终态转终态时顺带静默
 * 重读技能目录（导入成功的权威事实是服务端目录，不是任务回执）。启停、取消与
 * 记录删除按目标逐个记在途，连点单飞；探测结果未知（resource-busy）时保留服务
 * 端中文提示，不自动重试或跳转治理页面。
 */

export { selectImportsActive } from './agentExtensionImports'
export type { DeleteSkillTarget, SkillDetailState } from './agentExtensionSkills'

export type { CatalogState, ProbeState } from './agentExtensionMcp'

export type AgentExtensionsState = AgentExtensionSkillsState & AgentExtensionImportsState & AgentExtensionMcpState & {
  reset(): void
}

export const useAgentExtensionsStore = create<AgentExtensionsState>((set, get) => {
  const skills = createAgentExtensionSkills(set, get)
  const imports = createAgentExtensionImports(set, get)
  const mcp = createAgentExtensionMcp(set, get)

  return {
    ...skills.state,
    ...imports.state,
    ...mcp.state,
    reset() {
      set({ ...skills.reset(), ...imports.reset(), ...mcp.reset() })
    },
  }
})
