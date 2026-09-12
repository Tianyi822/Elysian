import type { Skill } from '@elysian/contracts'
import { create } from 'zustand'
import type { SkillAdapter } from '../contracts/adapters'

type SkillCatalogState = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  skills: readonly Skill[]
  errorMessage?: string
  actionError?: string
  /** 最近一次启停操作的说明。启停只改本地演示状态，不涉及真实环境。 */
  lastToggleNote?: string
  busySkillId?: string
  load: (adapter: SkillAdapter) => Promise<void>
  setEnabled: (adapter: SkillAdapter, skillId: string, enabled: boolean) => Promise<void>
}

export const useSkillCatalogStore = create<SkillCatalogState>((set) => ({
  status: 'idle',
  skills: [],
  async load(adapter) {
    set({ status: 'loading', errorMessage: undefined })
    try {
      const skills = await adapter.list()
      set({ status: 'ready', skills })
    } catch (error) {
      set({
        status: 'error',
        skills: [],
        errorMessage: error instanceof Error ? error.message : '读取技能目录失败',
      })
    }
  },
  async setEnabled(adapter, skillId, enabled) {
    set({ busySkillId: skillId, actionError: undefined, lastToggleNote: undefined })
    try {
      const updated = await adapter.setEnabled(skillId, enabled)
      set((state) => ({
        busySkillId: undefined,
        lastToggleNote: `${updated.name} 已在本地演示状态中${enabled ? '启用' : '停用'}，不代表真实环境变更。`,
        skills: state.skills.map((skill) => (skill.id === updated.id ? updated : skill)),
      }))
    } catch (error) {
      set({
        busySkillId: undefined,
        actionError: error instanceof Error ? error.message : '技能启停失败',
      })
    }
  },
}))
