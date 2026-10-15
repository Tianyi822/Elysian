import { validAgentModelDefaultReasoningLevel, validAgentModelReasoningLevels } from '@elysian/contracts'
import type { AgentModelProfile, AgentModelProfileInput, AgentModelService, AgentModelServiceInput } from '@elysian/contracts'
import { create } from 'zustand'
import { isDockerRuntime } from '../app/runtime/isDockerRuntime'
import type { ElysianGateway } from '../contracts/adapters'
import { useNotificationStore } from './notificationStore'

/** 模型配置的修订冲突保留表单草稿，由用户确认最新修订后提交。 */
export function isRevisionConflict(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'revision-conflict'
}

/** 模型设置独立读取目录；凭据只在提交内存中经过，不进入 store 或浏览器持久化。 */
export function validateModelInput(input: AgentModelProfileInput, hasCredential = false): string | undefined {
  if (input.provider !== 'openai-compatible' && input.provider !== 'deepseek' && input.provider !== 'zhipu') return '模型供应商无效'
  if (input.provider === 'zhipu') {
    if (input.apiFormat !== 'chat-completions') return '智谱服务当前仅支持 Chat Completions 格式'
    if (input.capabilities.reasoningLevels?.includes('disabled')) return '智谱模型的思考无法关闭，不能声明 disabled 推理档位'
  }
  if (input.apiFormat !== 'chat-completions' && input.apiFormat !== 'anthropic-messages' && input.apiFormat !== 'responses') return '模型 API 格式无效'
  if (!input.model.trim()) return '模型 ID 不能为空'
  if (!input.baseUrl.trim()) return '服务地址不能为空'
  if (!input.capabilities.source.trim()) return '能力来源不能为空'
  if (!Number.isSafeInteger(input.contextTokens) || input.contextTokens < 1 || input.contextTokens > 2_000_000) return '上下文上限必须是 1 到 2000000 的正整数'
  if (!Number.isSafeInteger(input.outputTokens) || input.outputTokens < 1 || input.outputTokens > input.contextTokens) return '输出上限必须是正整数且不能超过上下文上限'
  if (input.capabilities.reasoningLevels !== undefined && !validAgentModelReasoningLevels(input.capabilities.reasoningLevels)) return '推理等级最多 16 项，名称以小写字母开头，可含数字、下划线或短横线，且不能重复'
  if (!validAgentModelDefaultReasoningLevel(input.capabilities.reasoningLevels ?? [], input.capabilities.defaultReasoningLevel)) return '默认推理档必须是已声明的档位'
  if (!input.capabilities.text && !input.capabilities.tools) return '文本与工具能力至少勾选一项：派发要求由二者共同决定'
  const credentialPresent = input.credential === undefined ? hasCredential : input.credential.trim() !== ''
  if (!credentialPresent) return '请配置 API Key'
  return undefined
}

type ModelSettingsState = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  models: readonly AgentModelProfile[]
  services: readonly AgentModelService[]
  errorMessage?: string
  reloading: boolean
  saving: boolean
  search: string
  setSearch(value: string): void
  load(gateway: ElysianGateway): Promise<void>
  refresh(gateway: ElysianGateway): Promise<void>
  saveService(gateway: ElysianGateway, input: AgentModelServiceInput, editing?: { id: string; revision: number }): Promise<boolean>
  saveModel(gateway: ElysianGateway, input: AgentModelProfileInput, editing?: { id: string; revision: number }): Promise<boolean>
  reset(): void
}

const messageOf = (error: unknown) => error instanceof Error ? error.message : '读取模型配置失败'
const notify = (message: string, tone: 'success' | 'danger' = 'success') => useNotificationStore.getState().notify({ message, tone })
const initial = { status: 'idle' as const, models: [], services: [], reloading: false, saving: false, search: '', errorMessage: undefined }

export const useModelSettingsStore = create<ModelSettingsState>((set, get) => {
  let sequence = 0
  const read = async (gateway: ElysianGateway, refresh: boolean) => {
    const request = ++sequence
    set(refresh && get().status === 'ready' ? { reloading: true, errorMessage: undefined } : { status: 'loading', errorMessage: undefined })
    try {
      const services = await gateway.modelSettings.listModelServices()
      const models = services.flatMap(service => service.models)
      if (request === sequence) set({ models, services, status: 'ready', reloading: false, errorMessage: undefined })
    } catch (error) {
      if (request === sequence) set({ status: refresh && get().status === 'ready' ? 'ready' : 'error', reloading: false, errorMessage: messageOf(error) })
    }
  }
  return {
    ...initial,
    setSearch: (search) => set({ search }),
    async load(gateway) { if (get().status !== 'loading') await read(gateway, false) },
    async refresh(gateway) { await read(gateway, true) },
    async saveService(gateway, input, editing) {
      const current = get().services.find(service => service.id === editing?.id)
      if (!input.name.trim() || input.models.length < 1 || input.models.length > 64) { notify('请填写服务名称，并配置 1 至 64 个模型', 'danger'); return false }
      const duplicates = new Set<string>()
      for (const row of input.models) {
        const invalid = validateModelInput({ ...input, ...row, active: input.active && row.enabled }, current?.hasCredential)
        if (invalid) { notify(invalid, 'danger'); return false }
        if (duplicates.has(row.model.trim())) { notify('同一服务不能重复配置相同模型 ID', 'danger'); return false }
        duplicates.add(row.model.trim())
      }
      if ((input.provider === 'deepseek' || input.provider === 'zhipu') && input.active && !(input.credential === undefined ? current?.hasCredential : input.credential.trim())) { notify(input.provider === 'deepseek' ? '启用 DeepSeek 服务前请配置 API Key' : '启用智谱服务前请配置 API Key', 'danger'); return false }
      if (get().saving) return false
      set({ saving: true })
      try {
        const service = editing
          ? await gateway.modelSettings.updateModelService(editing.id, { ...input, expectedRevision: editing.revision })
          : await gateway.modelSettings.createModelService(input)
        set(state => { const services = [...state.services.filter(item => item.id !== service.id), service]; return { services, models: services.flatMap(item => item.models) } })
        notify(`模型服务「${service.name}」已${editing ? '更新' : '创建'}${isDockerRuntime() ? '' : '（演示数据）'}`)
        await get().refresh(gateway)
        return true
      } catch (error) {
        if (isRevisionConflict(error)) { await get().refresh(gateway); notify('模型服务已被其他修改更新，已读取最新修订，表单草稿已保留', 'danger') }
        else notify(messageOf(error), 'danger')
        return false
      } finally { set({ saving: false }) }
    },
    async saveModel(gateway, input, editing) {
      const current = get().models.find((item) => item.id === editing?.id)
      const invalid = validateModelInput(input, current?.hasCredential)
      if (invalid) { notify(invalid, 'danger'); return false }
      if (get().saving) return false
      set({ saving: true })
      try {
        const profile = editing
          ? await gateway.modelSettings.updateModelProfile(editing.id, { ...input, expectedRevision: editing.revision })
          : await gateway.modelSettings.createModelProfile(input)
        set((state) => ({ models: [...state.models.filter((item) => item.id !== profile.id), profile] }))
        notify(`模型配置「${profile.model}」已${editing ? '更新' : '创建'}（修订 ${profile.revision}）${isDockerRuntime() ? '' : '（演示数据）'}`)
        await get().refresh(gateway)
        return true
      } catch (error) {
        if (isRevisionConflict(error)) {
          await get().refresh(gateway)
          notify('模型配置已被其他修改更新，已重新读取最新修订，请基于最新内容重试', 'danger')
        } else notify(messageOf(error), 'danger')
        return false
      } finally { set({ saving: false }) }
    },
    reset() { sequence += 1; set(initial) },
  }
})
