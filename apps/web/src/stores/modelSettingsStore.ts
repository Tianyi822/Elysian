import { captureAuthGeneration } from '../adapters/http/unauthorized'
import { validAgentModelDefaultReasoningLevel, validAgentModelReasoningLevels } from '@elysian/contracts'
import type { AgentModelProfile, AgentModelProfileInput, AgentModelService, AgentModelServiceInput } from '@elysian/contracts'
import { create } from 'zustand'
import { isDockerRuntime } from '../app/runtime/isDockerRuntime'
import type { ElysianGateway } from '../contracts/adapters'
import { useMessageStore } from './messageStore'
import { tableBatchFailure as batchFailure, type TableBatchOutcome as BatchMutationResult } from '../utils/tableBatch'

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
  setModelsEnabled(gateway: ElysianGateway, service: AgentModelService, modelIds: readonly string[], enabled: boolean): Promise<BatchMutationResult>
  reset(): void
}

const messageOf = (error: unknown) => error instanceof Error ? error.message : '读取模型配置失败'
const notify = (message: string, tone: 'success' | 'danger' = 'success') => useMessageStore.getState().notify({ message, tone })
const initial = { status: 'idle' as const, models: [], services: [], reloading: false, saving: false, search: '', errorMessage: undefined }

export const useModelSettingsStore = create<ModelSettingsState>((set, get) => {
  let sequence = 0
  let writeEpoch = 0
  let pendingRead: { gateway: ElysianGateway; auth: number; models: readonly AgentModelProfile[]; services: readonly AgentModelService[]; promise: Promise<void> } | undefined
  const read = (gateway: ElysianGateway, refresh: boolean): Promise<void> => {
    const auth = captureAuthGeneration()
    if (pendingRead?.gateway === gateway && pendingRead.auth === auth && pendingRead.models === get().models && pendingRead.services === get().services) {
      if (refresh) set({ reloading: true })
      return pendingRead.promise
    }
    const request = ++sequence
    const hadData = get().status === 'ready'
    const operation = { gateway, auth, models: get().models, services: get().services, promise: Promise.resolve() }
    pendingRead = operation
    const current = () => request === sequence && auth === captureAuthGeneration()
    set({ status: hadData ? 'ready' : 'loading', reloading: refresh && hadData, errorMessage: undefined })
    operation.promise = (async () => {
      try {
        const services = await gateway.modelSettings.listModelServices()
        if (current() && operation.models === get().models && operation.services === get().services) set({ models: services.flatMap(service => service.models), services, status: 'ready', reloading: false, errorMessage: undefined })
      } catch (error) {
        if (current()) set({ status: hadData ? 'ready' : 'error', reloading: false, errorMessage: messageOf(error) })
      } finally { if (pendingRead === operation) { pendingRead = undefined; if (current()) set({ reloading: false }) } }
    })()
    return operation.promise
  }
  return {
    ...initial,
    setSearch: (search) => set({ search }),
    load(gateway) { return read(gateway, false) },
    async refresh(gateway) { await read(gateway, true) },
    async setModelsEnabled(gateway, snapshot, modelIds, enabled) {
      const current = get().services.find(service => service.id === snapshot.id)
      if (get().saving) return { status: 'failed', error: '模型配置正在保存，请稍后重试' }
      if (!current || current.revision !== snapshot.revision) return { status: 'failed', error: '模型服务修订已变化，请重新选择后重试' }
      if (enabled && !current.active) return { status: 'failed', error: '所属服务已停用，请先编辑并启用服务' }
      const ids = new Set(modelIds)
      if (!ids.size || modelIds.some(id => !current.models.some(model => model.id === id))) return { status: 'failed', error: '所选模型已变化，请重新选择后重试' }
      const input: AgentModelServiceInput = {
        name: current.name, provider: current.provider, apiFormat: current.apiFormat, baseUrl: current.baseUrl, active: current.active,
        models: current.models.map(model => ({ id: model.id, model: model.model, contextTokens: model.contextTokens,
          outputTokens: model.outputTokens, capabilities: model.capabilities, enabled: ids.has(model.id) ? enabled : model.enabled })),
      }
      const generation = writeEpoch, auth = captureAuthGeneration()
      const isCurrent = () => generation === writeEpoch && auth === captureAuthGeneration()
      sequence += 1; pendingRead = undefined
      set({ saving: true, reloading: false, errorMessage: undefined })
      try {
        const service = await gateway.modelSettings.updateModelService(current.id, { ...input, expectedRevision: current.revision })
        if (!isCurrent()) return { status: 'unknown', error: '登录状态已变化，请重新读取模型配置核实结果' }
        set(state => { const services = state.services.map(item => item.id === service.id && item.revision <= service.revision ? service : item); return { services, models: services.flatMap(item => item.models) } })
        return { status: 'succeeded' }
      } catch (error) {
        const result = batchFailure(error)
        if (isCurrent()) {
          set({ errorMessage: result.error })
          if (isRevisionConflict(error)) await read(gateway, false)
        }
        return result
      } finally { if (isCurrent()) set({ saving: false }) }
    },
    async saveService(gateway, input, editing) {
      const current = get().services.find(service => service.id === editing?.id)
      if (!input.name.trim() || input.models.length < 1 || input.models.length > 64) { set({ errorMessage: '请填写服务名称，并配置 1 至 64 个模型' }); return false }
      const duplicates = new Set<string>()
      for (const row of input.models) {
        const invalid = validateModelInput({ ...input, ...row, active: input.active && row.enabled }, current?.hasCredential)
        if (invalid) { set({ errorMessage: invalid }); return false }
        if (duplicates.has(row.model.trim())) { set({ errorMessage: '同一服务不能重复配置相同模型 ID' }); return false }
        duplicates.add(row.model.trim())
      }
      if ((input.provider === 'deepseek' || input.provider === 'zhipu') && input.active && !(input.credential === undefined ? current?.hasCredential : input.credential.trim())) { set({ errorMessage: input.provider === 'deepseek' ? '启用 DeepSeek 服务前请配置 API Key' : '启用智谱服务前请配置 API Key' }); return false }
      if (get().saving) return false
      sequence += 1; pendingRead = undefined
      set({ saving: true, errorMessage: undefined, reloading: false })
      try {
        const service = editing
          ? await gateway.modelSettings.updateModelService(editing.id, { ...input, expectedRevision: editing.revision })
          : await gateway.modelSettings.createModelService(input)
        set(state => { const services = [...state.services.filter(item => item.id !== service.id), service]; return { services, models: services.flatMap(item => item.models) } })
        notify(`模型服务「${service.name}」已${editing ? '更新' : '创建'}${isDockerRuntime() ? '' : '（演示数据）'}`)
        await read(gateway, false)
        return true
      } catch (error) {
        const message = isRevisionConflict(error) ? '模型服务已被其他修改更新，已读取最新修订，表单草稿已保留' : messageOf(error)
        if (isRevisionConflict(error)) await read(gateway, false)
        set({ errorMessage: message })
        notify(message, 'danger')
        return false
      } finally { set({ saving: false }) }
    },
    async saveModel(gateway, input, editing) {
      const current = get().models.find((item) => item.id === editing?.id)
      const invalid = validateModelInput(input, current?.hasCredential)
      if (invalid) { set({ errorMessage: invalid }); return false }
      if (get().saving) return false
      sequence += 1; pendingRead = undefined
      set({ saving: true, errorMessage: undefined, reloading: false })
      try {
        const profile = editing
          ? await gateway.modelSettings.updateModelProfile(editing.id, { ...input, expectedRevision: editing.revision })
          : await gateway.modelSettings.createModelProfile(input)
        set((state) => ({ models: [...state.models.filter((item) => item.id !== profile.id), profile] }))
        notify(`模型配置「${profile.model}」已${editing ? '更新' : '创建'}（修订 ${profile.revision}）${isDockerRuntime() ? '' : '（演示数据）'}`)
        await read(gateway, false)
        return true
      } catch (error) {
        const message = isRevisionConflict(error) ? '模型配置已被其他修改更新，已重新读取最新修订，请基于最新内容重试' : messageOf(error)
        if (isRevisionConflict(error)) await read(gateway, false)
        set({ errorMessage: message })
        notify(message, 'danger')
        return false
      } finally { set({ saving: false }) }
    },
    reset() { sequence += 1; writeEpoch += 1; pendingRead = undefined; set(initial) },
  }
})
