import { useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Link } from 'react-router'
import type { AgentEnvironment, AgentModelProfile, AgentSession } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { CTL_SECONDARY } from '../../components/formControl'
import { useInFlightSubmit } from '../../components/agent/useInFlightSubmit'
import { useNotificationStore } from '../../stores/notificationStore'
import { useAgentWorkbenchStore } from '../../stores/agentWorkbenchStore'
import { EMPTY_ENVIRONMENT_DRAFT, EnvironmentFields, MemorySpacePicker, draftToEnvironment, type EnvironmentDraft } from './EnvironmentFields'
import { useReferenceCatalog } from './useReferenceCatalog'

/*
 * 新建会话与会话设置两个对话框。共用形态：Radix Dialog（Overlay bg-overlay＋
 * Content panel-surface，Dialog.Title 必写）、单飞锁（useInFlightSubmit 的
 * inFlightOnly 档——这三个写端点都没有 requestId 字段）、行内错误 role=alert。
 * 模型列表的 hasCredential=false 项禁选并提示「缺少凭据，需先在能力配置补齐」。
 * 编辑会话的当前记忆空间先经 GET /sessions/{id}/memory 回显，环境先读现值。
 */

const DIALOG_BODY = 'fixed left-1/2 top-1/2 z-[61] w-[min(44rem,calc(100vw-2rem))] max-h-[calc(100vh-4rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto panel-surface p-4 shadow-xl'

function ModelPicker({
  profiles,
  value,
  onSelect,
  disabled,
}: {
  profiles: readonly AgentModelProfile[]
  value: string | undefined
  onSelect(profile: AgentModelProfile): void
  disabled?: boolean
}) {
  if (profiles.length === 0) {
    return <p className="text-xs text-fg-subtle">还没有可用的模型配置，请先在<Link to="/settings?tab=models" className="mx-0.5 underline underline-offset-2 hover:text-fg">设置中的模型配置</Link>页创建。</p>
  }
  return (
    <fieldset className="flex flex-col gap-1" disabled={disabled}>
      <legend className="sr-only">模型修订</legend>
      {profiles.map((profile) => {
        const key = `${profile.id}:${profile.revision}`
        const missing = !profile.hasCredential
        const selected = value === key
        return (
          <label
            key={key}
            className={`flex items-start gap-2 rounded px-1 py-1 text-xs ${missing || disabled ? 'cursor-not-allowed' : 'cursor-pointer'} ${selected ? 'bg-surface-raised' : 'hover:bg-surface-raised'} ${missing ? 'opacity-70' : ''}`}
          >
            <input
              type="radio"
              name="workbench-model-profile"
              checked={selected}
              disabled={disabled || missing}
              onChange={() => onSelect(profile)}
              className="mt-0.5 size-3.5 accent-[var(--color-accent)]"
            />
            <span className="min-w-0">
              <span className="block break-all text-fg">{profile.name} · {profile.model}（修订 {profile.revision}）</span>
              {missing
                ? <span className="block text-warning">缺少凭据，需先在能力配置补齐</span>
                : <span className="block text-fg-subtle">上下文 {profile.contextTokens} token · 输出 {profile.outputTokens} token · {profile.active ? '启用中' : '已停用'}</span>}
            </span>
          </label>
        )
      })}
    </fieldset>
  )
}

function useCapabilityOptions() {
  const gateway = useGateway()
  const [models, setModels] = useState<readonly AgentModelProfile[] | undefined>(undefined)
  const [executionProfiles, setExecutionProfiles] = useState<readonly { id: string; revision: number; name: string }[]>([])
  const [grants, setGrants] = useState<readonly { id: string; revision: number; name: string }[]>([])
  const [resourceRules, setResourceRules] = useState<readonly { id: string; revision: number; name: string }[]>([])
  const [spaces, setSpaces] = useState<readonly { id: string; name: string; kind: string }[]>([])
  const [error, setError] = useState<string | undefined>(undefined)
  const catalog = useReferenceCatalog()
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const [modelResult, executionResult, grantResult, ruleResult, spaceResult] = await Promise.allSettled([
          gateway.agentCapabilities.listModelProfiles(),
          gateway.agentCapabilities.listExecutionProfiles(),
          gateway.agentCapabilities.listGrants(),
          gateway.agentCapabilities.listResourceRules(),
          gateway.agentMemory.listSpaces(),
      ])
      if (cancelled) return
      if (modelResult.status === 'fulfilled') setModels(modelResult.value)
      else setError(modelResult.reason instanceof Error ? modelResult.reason.message : '读取模型配置失败')
      if (executionResult.status === 'fulfilled') setExecutionProfiles(executionResult.value.map((item) => ({ id: item.id, revision: item.revision, name: item.name })))
      if (grantResult.status === 'fulfilled') setGrants(grantResult.value.map((item) => ({ id: item.id, revision: item.revision, name: item.name })))
      if (ruleResult.status === 'fulfilled') setResourceRules(ruleResult.value.map((item) => ({ id: item.id, revision: item.revision, name: item.name })))
      if (spaceResult.status === 'fulfilled') setSpaces(spaceResult.value.map((item) => ({ id: item.id, name: item.name, kind: item.kind })))
    }
    void load()
    void catalog.load(gateway)
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateway])
  return { models, executionProfiles, grants, resourceRules, spaces, error, catalog }
}

function environmentToDraft(environment: AgentEnvironment | undefined): EnvironmentDraft {
  if (environment === undefined) return EMPTY_ENVIRONMENT_DRAFT
  return {
    skills: environment.skills.map((ref) => `${ref.id}:${ref.revision}`),
    servers: environment.servers.map((ref) => `${ref.id}:${ref.revision}`),
    tools: [...environment.tools],
    resources: environment.resources.map((ref) => `${ref.serverId}:${ref.uri}`),
    trustedReadOnly: [...environment.trustedReadOnly],
    executionProfiles: environment.executionProfiles.map((ref) => `${ref.id}:${ref.revision}`),
    grants: environment.grants.map((ref) => `${ref.id}:${ref.revision}`),
    resourceRules: (environment.resourceRules ?? []).map((ref) => `${ref.id}:${ref.revision}`),
  }
}

export function CreateSessionDialog({ onClose }: { onClose(): void }) {
  const gateway = useGateway()
  const options = useCapabilityOptions()
  const { submitting, inFlightOnly } = useInFlightSubmit()
  const createSession = useAgentWorkbenchStore((state) => state.createSession)
  const selectSession = useAgentWorkbenchStore((state) => state.selectSession)
  const notify = useNotificationStore((state) => state.notify)
  const [title, setTitle] = useState('')
  const [modelKey, setModelKey] = useState<string | undefined>(undefined)
  const [draft, setDraft] = useState<EnvironmentDraft>(EMPTY_ENVIRONMENT_DRAFT)
  const [memory, setMemory] = useState({ spaceId: '', includeGlobal: false })
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined)
  const [createdSession, setCreatedSession] = useState<AgentSession | undefined>(undefined)

  const submit = async () => {
    const trimmed = title.trim()
    if (!trimmed) {
      setErrorMessage('会话标题不能为空')
      return
    }
    if (modelKey === undefined) {
      setErrorMessage('请选择一个模型修订')
      return
    }
    const separator = modelKey.lastIndexOf(':')
    const modelProfileId = modelKey.slice(0, separator)
    const modelRevision = Number(modelKey.slice(separator + 1))
    await inFlightOnly(async () => {
      try {
        const session = createdSession ?? await createSession(gateway, {
          title: trimmed,
          modelProfileId,
          modelRevision,
        })
        setCreatedSession(session)
        const environment = await gateway.agentWorkbench.getSessionEnvironment(session.id)
        await gateway.agentWorkbench.updateSessionEnvironment(session.id, environment.revision, draftToEnvironment(draft, session.id, environment.revision))
        if (memory.spaceId !== '' || memory.includeGlobal) {
          await gateway.agentWorkbench.writeSessionMemorySelection(session.id, memory)
        }
        selectSession(session.id)
        notify({ tone: 'success', message: '会话已创建' })
        onClose()
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : '创建会话失败')
      }
    })
  }

  const busyHint = options.error

  return (
    <Dialog.Root open onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay" />
        <Dialog.Content aria-describedby={undefined} className={DIALOG_BODY}>
          <Dialog.Title className="text-sm font-semibold">{createdSession ? '完成会话配置' : '新建会话'}</Dialog.Title>
          {createdSession ? <p role="status" className="mt-2 text-xs text-warning">会话 {createdSession.id} 已创建；重试只继续保存配置，不会再创建会话。</p> : null}
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void submit()
            }}
          >
            <label htmlFor="workbench-new-session-title" className="mt-3 block text-xs text-fg-muted">会话标题</label>
            <input
              id="workbench-new-session-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              autoFocus
              className="ctl-field mt-1 w-full"
              placeholder="例如：容器巡检"
            />

            <p className="mt-3 text-xs font-medium text-fg-muted">模型修订</p>
            <div className="mt-1">
              {options.models === undefined && busyHint === undefined ? <p className="text-xs text-fg-subtle">正在读取模型配置…</p> : null}
              {busyHint ? <p role="alert" className="text-xs text-danger">{busyHint}</p> : null}
              {options.models !== undefined
                ? <ModelPicker profiles={options.models} value={modelKey} onSelect={(profile) => setModelKey(`${profile.id}:${profile.revision}`)} />
                : null}
            </div>

            <p className="mt-3 text-xs font-medium text-fg-muted">能力环境</p>
            <p className="mb-1 text-[11px] text-fg-subtle">可先跳过，创建后在会话设置里编辑；环境修订递增受服务端 CAS 保护。</p>
            <EnvironmentFields
              catalog={options.catalog}
              gateway={gateway}
              draft={draft}
              onDraft={setDraft}
              executionProfiles={options.executionProfiles}
              grants={options.grants}
              resourceRules={options.resourceRules}
            />

            <div className="mt-3">
              <MemorySpacePicker spaces={options.spaces} value={memory} onChange={setMemory} />
            </div>

            {errorMessage ? <p role="alert" className="mt-3 text-xs text-danger">{errorMessage}</p> : null}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={onClose} className={`${CTL_SECONDARY} px-3 py-1.5 text-xs`}>取消</button>
              <button type="submit" disabled={submitting} className="rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:border-fg-subtle disabled:cursor-not-allowed disabled:opacity-50">
                {submitting ? '正在创建…' : '创建会话'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export function SessionSettingsDialog({ session, onClose }: { session: AgentSession; onClose(): void }) {
  const gateway = useGateway()
  const options = useCapabilityOptions()
  const store = useAgentWorkbenchStore()
  const { submitting, inFlightOnly } = useInFlightSubmit()
  const notify = useNotificationStore((state) => state.notify)
  const [modelKey, setModelKey] = useState<string | undefined>(`${session.modelProfileId}:${session.modelRevision}`)
  const [draft, setDraft] = useState<EnvironmentDraft>(EMPTY_ENVIRONMENT_DRAFT)
  const [memory, setMemory] = useState({ spaceId: '', includeGlobal: false })
  const [environmentRevision, setEnvironmentRevision] = useState<number | undefined>(undefined)
  const [serverEnvironment, setServerEnvironment] = useState<AgentEnvironment | undefined>(undefined)
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined)
  const [memoryEchoed, setMemoryEchoed] = useState(false)

  const busy = session.activeRunId !== undefined || session.activeWorkflowId !== undefined

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        // 写前先回显服务端现值：记忆空间与环境的当前选择以服务端为权威。
        const [selection, environment] = await Promise.all([
          gateway.agentWorkbench.readSessionMemorySelection(session.id),
          gateway.agentWorkbench.getSessionEnvironment(session.id),
        ])
        if (cancelled) return
        setMemory({ spaceId: selection.spaceId, includeGlobal: selection.includeGlobal })
        setDraft(environmentToDraft(environment))
        setEnvironmentRevision(environment.revision)
        setMemoryEchoed(true)
      } catch (cause) {
        if (cancelled) return
        setErrorMessage(cause instanceof Error ? cause.message : '读取会话配置失败')
      }
    }
    void load()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id])

  const submit = async () => {
    await inFlightOnly(async () => {
      try {
        if (modelKey !== undefined && modelKey !== `${session.modelProfileId}:${session.modelRevision}`) {
          const separator = modelKey.lastIndexOf(':')
          await store.switchModel(gateway, session.id, {
            modelProfileId: modelKey.slice(0, separator),
            modelRevision: Number(modelKey.slice(separator + 1)),
          })
        }
        if (environmentRevision !== undefined) {
          await store.updateEnvironment(gateway, session.id, environmentRevision, draftToEnvironment(draft, session.id, environmentRevision))
        }
        await store.saveMemorySelection(gateway, session.id, memory)
        notify({ tone: 'success', message: '会话设置已保存' })
        onClose()
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : '保存会话设置失败')
        // 冲突（409 revision-conflict 等）后回读最新环境修订，避免盲写。
        try {
          const environment = await gateway.agentWorkbench.getSessionEnvironment(session.id)
          setEnvironmentRevision(environment.revision)
          setServerEnvironment(environment)
        } catch { /* 回读失败保持现值，由用户重试 */ }
      }
    })
  }

  return (
    <Dialog.Root open onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay" />
        <Dialog.Content aria-describedby={undefined} className={DIALOG_BODY}>
          <Dialog.Title className="text-sm font-semibold">会话设置「{session.title}」</Dialog.Title>
          {busy ? (
            <p role="status" className="mt-2 rounded-lg border border-line bg-surface px-2 py-1.5 text-xs text-warning">
              会话有进行中的运行或工作流：模型切换、环境编辑与记忆空间选择在运行期间被服务端拒绝（409 session-busy），请等待运行结束。
            </p>
          ) : null}
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void submit()
            }}
          >
            <p className="mt-3 text-xs font-medium text-fg-muted">模型修订（当前：{session.modelProfileId} 修订 {session.modelRevision}）</p>
            <div className="mt-1">
              {options.models !== undefined
                ? <ModelPicker profiles={options.models} value={modelKey} onSelect={(profile) => setModelKey(`${profile.id}:${profile.revision}`)} disabled={busy} />
                : <p className="text-xs text-fg-subtle">正在读取模型配置…</p>}
            </div>

            <p className="mt-3 text-xs font-medium text-fg-muted">能力环境{environmentRevision !== undefined ? `（修订 ${environmentRevision}）` : ''}</p>
            <EnvironmentFields
              catalog={options.catalog}
              gateway={gateway}
              draft={draft}
              onDraft={setDraft}
              disabled={busy}
              executionProfiles={options.executionProfiles}
              grants={options.grants}
              resourceRules={options.resourceRules}
            />
            {serverEnvironment ? <div className="mt-2 rounded border border-warning/40 p-2 text-xs text-warning"><p>服务端当前环境（修订 {serverEnvironment.revision}）；您的编辑仍保留在上方。请核对后重新保存。</p><pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all text-[10px]">{JSON.stringify(serverEnvironment, null, 2)}</pre></div> : null}

            <div className="mt-3">
              <MemorySpacePicker spaces={options.spaces} value={memory} onChange={setMemory} disabled={busy} error={memoryEchoed ? undefined : '正在回显服务端当前选择…'} />
            </div>

            {errorMessage ? <p role="alert" className="mt-3 text-xs text-danger">{errorMessage}</p> : null}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={onClose} className={`${CTL_SECONDARY} px-3 py-1.5 text-xs`}>取消</button>
              <button type="submit" disabled={submitting || busy || !memoryEchoed} className="rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:border-fg-subtle disabled:cursor-not-allowed disabled:opacity-50">
                {submitting ? '正在保存…' : '保存会话设置'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
