import type { AgentSkill, AgentSkillFilePreview } from '@elysian/contracts'
import type { ElysianGateway } from '../contracts/adapters'
import { AgentHttpError } from '../contracts/agentHttpError'
import { tableBatchFailure as batchFailure, type TableBatchOutcome as BatchMutationResult } from '../utils/tableBatch'
import { messageOf, MOCK_SUFFIX, notify } from './agentExtensionsFeedback'
import { createRequestGuard } from './requestGuard'

export type SkillDetailState = {
  skillId: string
  revision?: number
  status: 'loading' | 'ready' | 'error'
  item?: AgentSkill
  errorMessage?: string
  file: { path: string; status: 'loading' | 'ready' | 'error'; preview?: AgentSkillFilePreview; errorMessage?: string } | null
}

export type DeleteSkillTarget = { skillId: string; name: string; revision: number }

type SkillDisplay = {
  skillsStatus: 'idle' | 'loading' | 'ready' | 'error'
  skills: readonly AgentSkill[]
  skillsErrorMessage?: string
  skillsRefreshing: boolean
  togglingSkillIds: readonly string[]
  skillDetail: SkillDetailState | null
  deleteTarget: DeleteSkillTarget | null
  deletingSkill: boolean
}

export type AgentExtensionSkillsState = SkillDisplay & {
  loadSkills(gateway: ElysianGateway, options?: { silent?: boolean }): Promise<void>
  loadSkillDetail(gateway: ElysianGateway, skillId: string, revision?: number): Promise<void>
  loadSkillFile(gateway: ElysianGateway, skillId: string, revision: number, path: string): Promise<void>
  closeSkillDetail(): void
  setSkillEnabled(gateway: ElysianGateway, skillId: string, expectedRevision: number, enabled: boolean): Promise<void>
  setSkillEnabledResult(gateway: ElysianGateway, skill: AgentSkill, enabled: boolean): Promise<BatchMutationResult>
  deleteSkillResult(gateway: ElysianGateway, skill: AgentSkill): Promise<BatchMutationResult>
  requestDeleteSkill(target: DeleteSkillTarget): void
  cancelDeleteSkill(): void
  confirmDeleteSkill(gateway: ElysianGateway): Promise<void>
}

const blankSkills = (): SkillDisplay => ({
  skillsStatus: 'idle',
  skillsErrorMessage: undefined,
  skills: [],
  skillsRefreshing: false,
  togglingSkillIds: [],
  skillDetail: null,
  deleteTarget: null,
  deletingSkill: false,
})

export function createAgentExtensionSkills(set: (state: Partial<SkillDisplay>) => void, get: () => AgentExtensionSkillsState) {
  const requests = createRequestGuard()
  const skillDetailRequest = createRequestGuard()
  const skillFileRequest = createRequestGuard()
  let pendingList: { gateway: ElysianGateway; isCurrent: () => boolean; snapshot: readonly AgentSkill[]; promise: Promise<void> } | undefined

  const state: AgentExtensionSkillsState = {
    ...blankSkills(),
    loadSkills(gateway, options) {
      const previous = pendingList
      if (previous?.gateway === gateway && previous.isCurrent() && previous.snapshot === get().skills) {
        if (!options?.silent) set({ skillsRefreshing: true })
        return previous.promise
      }
      const inPlace = get().skillsStatus === 'ready'
      const operation = { gateway, isCurrent: requests.capture(), snapshot: get().skills, promise: Promise.resolve() }
      pendingList = operation
      const current = () => operation.isCurrent() && pendingList === operation
      set({ skillsStatus: inPlace ? 'ready' : 'loading', skillsRefreshing: inPlace && !options?.silent, skillsErrorMessage: undefined })
      operation.promise = (async () => {
        try {
          const items = await gateway.agentExtensions.listSkills()
          if (current() && operation.snapshot === get().skills) set({ skillsStatus: 'ready', skills: items, skillsErrorMessage: undefined })
        } catch (error) {
          if (current()) set({ skillsStatus: inPlace ? 'ready' : 'error', skillsErrorMessage: messageOf(error) })
        } finally {
          if (pendingList === operation) {
            pendingList = undefined
            if (operation.isCurrent()) set({ skillsRefreshing: false })
          }
        }
      })()
      return operation.promise
    },
    async loadSkillDetail(gateway, skillId, revision) {
      const isCurrent = skillDetailRequest.replace()
      skillFileRequest.invalidate()
      set({ skillDetail: { skillId, revision, status: 'loading', file: null } })
      try {
        const item = await gateway.agentExtensions.getSkill(skillId, revision)
        if (!isCurrent()) return
        set({ skillDetail: { skillId, revision: item.revision, status: 'ready', item, file: null } })
        if (item.files.some(file => file.path === 'SKILL.md')) void get().loadSkillFile(gateway, skillId, item.revision, 'SKILL.md')
      } catch (error) {
        if (!isCurrent()) return
        set({ skillDetail: { skillId, revision, status: 'error', errorMessage: messageOf(error), file: null } })
      }
    },
    async loadSkillFile(gateway, skillId, revision, path) {
      const isCurrent = skillFileRequest.replace()
      const current = get().skillDetail
      if (current === null || current.skillId !== skillId || current.revision !== revision || current.item === undefined) return
      set({ skillDetail: { ...current, file: { path, status: 'loading' } } })
      try {
        const preview = await gateway.agentExtensions.getSkillFile(skillId, revision, path)
        if (!isCurrent()) return
        const latest = get().skillDetail
        if (latest?.skillId === skillId && latest.revision === revision && latest.file?.path === path) {
          set({ skillDetail: { ...latest, file: { path, status: 'ready', preview } } })
        }
      } catch (error) {
        if (!isCurrent()) return
        const latest = get().skillDetail
        if (latest?.skillId === skillId && latest.revision === revision && latest.file?.path === path) {
          set({ skillDetail: { ...latest, file: { path, status: 'error', errorMessage: messageOf(error) } } })
        }
      }
    },
    closeSkillDetail() {
      skillDetailRequest.invalidate()
      skillFileRequest.invalidate()
      set({ skillDetail: null })
    },
    async setSkillEnabled(gateway, skillId, expectedRevision, enabled) {
      const isCurrent = requests.capture()
      if (get().deletingSkill || get().togglingSkillIds.includes(skillId)) return
      set({ togglingSkillIds: [...get().togglingSkillIds, skillId] })
      try {
        const item = await gateway.agentExtensions.setSkillEnabled(skillId, expectedRevision, enabled)
        if (!isCurrent()) return
        set({
          skills: get().skills.map((entry) => (entry.id === item.id ? item : entry)),
          togglingSkillIds: get().togglingSkillIds.filter((id) => id !== skillId),
        })
        notify(enabled ? 'success' : 'info', `技能「${item.manifest.name}」已${enabled ? '启用' : '停用'}（修订 ${item.revision}）${MOCK_SUFFIX}`)
      } catch (error) {
        if (!isCurrent()) return
        set({ togglingSkillIds: get().togglingSkillIds.filter((id) => id !== skillId) })
        if (error instanceof AgentHttpError && error.status === 409) void get().loadSkills(gateway, { silent: true })
        notify('danger', messageOf(error))
      }
    },
    async setSkillEnabledResult(gateway, skill, enabled) {
      const current = get().skills.find(item => item.id === skill.id)
      if (!current || current.revision !== skill.revision) return { status: 'failed', error: 'Skill 修订已变化，请重新选择后重试' }
      if (get().deletingSkill || get().togglingSkillIds.includes(skill.id)) return { status: 'failed', error: 'Skill 正在修改，请稍后重试' }
      const isCurrent = requests.capture()
      set({ togglingSkillIds: [...get().togglingSkillIds, skill.id] })
      try {
        const item = await gateway.agentExtensions.setSkillEnabled(skill.id, skill.revision, enabled)
        if (!isCurrent()) return { status: 'unknown', error: '登录状态已变化，请重新读取 Skill 核实结果' }
        set({ skills: get().skills.map(entry => entry.id === item.id && entry.revision <= item.revision ? item : entry) })
        return { status: 'succeeded' }
      } catch (error) {
        if (isCurrent() && error instanceof AgentHttpError && error.status === 409) void get().loadSkills(gateway, { silent: true })
        return batchFailure(error)
      } finally { if (isCurrent()) set({ togglingSkillIds: get().togglingSkillIds.filter(id => id !== skill.id) }) }
    },
    async deleteSkillResult(gateway, skill) {
      const current = get().skills.find(item => item.id === skill.id)
      if (!current || current.revision !== skill.revision) return { status: 'failed', error: 'Skill 修订已变化，请重新选择后重试' }
      if (get().deletingSkill || get().togglingSkillIds.includes(skill.id)) return { status: 'failed', error: 'Skill 正在修改，请稍后重试' }
      const isCurrent = requests.capture()
      set({ deletingSkill: true })
      try {
        await gateway.agentExtensions.deleteSkill(skill.id, skill.revision)
        if (!isCurrent()) return { status: 'unknown', error: '登录状态已变化，请重新读取 Skill 核实结果' }
        set({ skills: get().skills.filter(item => item.id !== skill.id || item.revision > skill.revision) })
        return { status: 'succeeded' }
      } catch (error) {
        if (isCurrent() && error instanceof AgentHttpError && error.status === 409) void get().loadSkills(gateway, { silent: true })
        return batchFailure(error)
      } finally { if (isCurrent()) set({ deletingSkill: false }) }
    },
    requestDeleteSkill(target) {
      set({ deleteTarget: target })
    },
    cancelDeleteSkill() {
      set({ deleteTarget: null })
    },
    async confirmDeleteSkill(gateway) {
      const isCurrent = requests.capture()
      const target = get().deleteTarget
      if (target === null || get().deletingSkill || get().togglingSkillIds.includes(target.skillId)) return
      set({ deletingSkill: true })
      try {
        await gateway.agentExtensions.deleteSkill(target.skillId, target.revision)
        if (!isCurrent()) return
        set({
          deletingSkill: false,
          deleteTarget: null,
          skills: get().skills.filter((item) => item.id !== target.skillId),
        })
        notify('success', `技能「${target.name}」已删除，全部修订登记已移除${MOCK_SUFFIX}`)
      } catch (error) {
        if (!isCurrent()) return
        set({ deletingSkill: false, deleteTarget: null })
        if (error instanceof AgentHttpError && error.status === 409) void get().loadSkills(gateway, { silent: true })
        notify('danger', messageOf(error))
      }
    },
  }

  return {
    state,
    reset() {
      pendingList = undefined
      requests.invalidate()
      skillDetailRequest.invalidate()
      skillFileRequest.invalidate()
      return blankSkills()
    },
  }
}
