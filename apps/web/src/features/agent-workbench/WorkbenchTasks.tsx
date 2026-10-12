import { useEffect, useMemo, useState } from 'react'
import type { AgentInput, AgentMessage, AgentPromptRef, AgentResourceRef, AgentRevisionRef, AgentSession, RuntimeRun, RuntimeTask } from '@elysian/contracts'
import { runtimeRunIsActive } from '@elysian/contracts'
import { ChevronDown, MessagesSquare, Settings } from '../../components/icons'
import { CTL_SECONDARY } from '../../components/formControl'
import { EmptyState, ErrorState, LoadingState } from '../../components/states/StateViews'
import { formatDateTime } from '../../components/format'
import { AgentRunStatusTag } from '../../components/agent/AgentStatusTag'
import { useInFlightSubmit } from '../../components/agent/useInFlightSubmit'
import { useNotificationStore } from '../../stores/notificationStore'
import { useAgentWorkbenchStore } from '../../stores/agentWorkbenchStore'
import type { ElysianGateway } from '../../contracts/adapters'
import { MEMORY_STATUS_LABELS } from './workbenchDisplay'
import { useReferenceCatalog } from './useReferenceCatalog'

/*
 * 主区：会话头部（模型/busy 原因/会话设置入口）→ 任务选择条 → 当前任务的公开
 * 消息流 + 输入区。输入区两种形态：未选任务＝新建任务（「创建并运行」），已选
 * 任务＝续轮（「继续任务」）；都走 requestId 白名单档（useInFlightSubmit 的
 * withRequestId）：同输入复用同一 requestId（断线重试幂等回读），输入变化才
 * 生成新键。会话 busy 期间禁用输入并显示原因；409 的服务端中文文案行内展示。
 */

/** 会话任务的展示目标：agent/workflow 任务带 goal，批次任务回退到标识。 */
function taskGoalOf(task: RuntimeTask): string {
  return 'goal' in task && task.goal !== '' ? task.goal : task.id
}

const INPUT_LIMIT_BYTES = 32 * 1024

export function WorkbenchTasks({
  gateway,
  session,
  degraded,
  onOpenSettings,
}: {
  gateway: ElysianGateway
  session: AgentSession | undefined
  degraded: boolean
  onOpenSettings(): void
}) {
  const tasksStatus = useAgentWorkbenchStore((state) => state.tasksStatus)
  const tasks = useAgentWorkbenchStore((state) => state.tasks)
  const tasksError = useAgentWorkbenchStore((state) => state.tasksError)
  const tasksHasMore = useAgentWorkbenchStore((state) => state.tasksHasMore)
  const selectedTaskId = useAgentWorkbenchStore((state) => state.selectedTaskId)
  const selectTask = useAgentWorkbenchStore((state) => state.selectTask)
  const loadTasks = useAgentWorkbenchStore((state) => state.loadTasks)

  const busy = session !== undefined && (session.activeRunId !== undefined || session.activeWorkflowId !== undefined)

  return (
    <section aria-label="会话任务" className="flex min-h-0 flex-col panel-surface">
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <h2 className="flex min-w-0 items-center gap-1.5 text-xs font-semibold text-fg">
          <MessagesSquare aria-hidden size={14} />
          <span className="truncate" title={session?.title}>{session?.title ?? '未选择会话'}</span>
        </h2>
        {session ? (
          <span className="text-[10px] text-fg-subtle">
            模型 {session.modelProfileId}（修订 {session.modelRevision}）
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-1.5">
          {degraded ? (
            <span role="status" className="text-[10px] text-warning">连接中断，正在重试</span>
          ) : null}
          {session ? (
            <button type="button" onClick={onOpenSettings} className={`${CTL_SECONDARY} px-2 py-1 text-[11px]`} disabled={busy} title={busy ? '会话 busy 期间不能修改模型、环境与记忆空间' : undefined}>
              <span className="inline-flex items-center gap-1"><Settings aria-hidden size={12} />会话设置</span>
            </button>
          ) : null}
        </span>
      </header>

      {session ? (
        <>
          <div className="border-b border-line px-3 py-2">
            <TaskStrip
              tasks={tasks}
              status={tasksStatus}
              error={tasksError}
              selectedTaskId={selectedTaskId}
              onSelect={selectTask}
              onRetry={() => void loadTasks(gateway)}
            />
            {tasksHasMore ? <button type="button" className="mt-1 text-[11px] text-accent-fg underline" onClick={() => void loadTasks(gateway, { more: true })}>加载更多任务</button> : null}
          </div>
          <TaskConversation gateway={gateway} session={session} busy={busy} />
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center p-6">
          <EmptyState title="选择或创建一个会话" description="左侧选择会话后在这里查看任务与对话；或新建一个会话开始。" />
        </div>
      )}
    </section>
  )
}

function TaskStrip({
  tasks,
  status,
  error,
  selectedTaskId,
  onSelect,
  onRetry,
}: {
  tasks: readonly RuntimeTask[]
  status: 'idle' | 'loading' | 'ready' | 'error'
  error?: string
  selectedTaskId?: string
  onSelect(taskId: string | undefined): void
  onRetry(): void
}) {
  if (status === 'loading' && tasks.length === 0) return <LoadingState label="正在加载任务…" />
  if (status === 'error') return <ErrorState description={error} onRetry={onRetry} />
  if (tasks.length === 0) {
    return <p className="text-xs text-fg-subtle">还没有任务：在下方输入并「创建并运行」。</p>
  }
  return (
    <div className="flex gap-1 overflow-x-auto hover-scrollbar pb-0.5" role="tablist" aria-label="任务选择">
      <button
        type="button"
        role="tab"
        aria-selected={selectedTaskId === undefined}
        onClick={() => onSelect(undefined)}
        className={`shrink-0 rounded-lg border px-2 py-1 text-[11px] transition-colors ${selectedTaskId === undefined ? 'border-accent/50 bg-accent/10 text-accent-fg' : 'border-line text-fg-muted hover:text-fg'}`}
      >
        新建任务
      </button>
      {tasks.map((task) => (
        <button
          key={task.id}
          type="button"
          role="tab"
          aria-selected={task.id === selectedTaskId}
          onClick={() => onSelect(task.id)}
          title={taskGoalOf(task)}
          className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] transition-colors ${task.id === selectedTaskId ? 'border-accent/50 bg-accent/10 text-accent-fg' : 'border-line text-fg-muted hover:text-fg'}`}
        >
          <span className="max-w-40 truncate">{taskGoalOf(task)}</span>
          {task.latestRun ? <AgentRunStatusTag status={task.latestRun.status} /> : null}
          {task.memoryStatus ? (
            <span className="rounded border border-line px-1 text-[10px] text-fg-subtle">记忆{MEMORY_STATUS_LABELS[task.memoryStatus]}</span>
          ) : null}
        </button>
      ))}
    </div>
  )
}

function TaskConversation({ gateway, session, busy }: { gateway: ElysianGateway; session: AgentSession; busy: boolean }) {
  const selectedTaskId = useAgentWorkbenchStore((state) => state.selectedTaskId)
  const taskDetail = useAgentWorkbenchStore((state) => state.taskDetail)
  const taskStatus = useAgentWorkbenchStore((state) => state.taskStatus)
  const taskError = useAgentWorkbenchStore((state) => state.taskError)
  const messages = useAgentWorkbenchStore((state) => state.messages)
  const messagesStatus = useAgentWorkbenchStore((state) => state.messagesStatus)
  const messagesError = useAgentWorkbenchStore((state) => state.messagesError)
  const createTask = useAgentWorkbenchStore((state) => state.createTask)
  const continueRunTask = useAgentWorkbenchStore((state) => state.continueRunTask)
  const drafts = useAgentWorkbenchStore((state) => state.drafts)
  const setDraft = useAgentWorkbenchStore((state) => state.setDraft)
  const pendingInputs = useAgentWorkbenchStore((state) => state.pendingInputs)
  const setPendingInput = useAgentWorkbenchStore((state) => state.setPendingInput)
  const notify = useNotificationStore((state) => state.notify)

  const draftKey = `${session.id}:${selectedTaskId ?? 'new'}`
  const draft = drafts[draftKey] ?? { content: '', skills: [], resources: [], prompts: [], promptArguments: {} }
  const updateDraft = (patch: Partial<typeof draft>) => setDraft(draftKey, { ...draft, ...patch })
  const pending = pendingInputs[draftKey]
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined)
  const [referencesOpen, setReferencesOpen] = useState(false)
  const { submitting, withRequestId, inFlightOnly, newRequestId } = useInFlightSubmit()
  const catalog = useReferenceCatalog()

  useEffect(() => {
    if (referencesOpen && catalog.status === 'idle') void catalog.load(gateway)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [referencesOpen])

  const taskMessages = useMemo(
    () => messages.filter((message) => selectedTaskId === undefined || message.taskId === selectedTaskId),
    [messages, selectedTaskId],
  )

  const latestRun = taskDetail?.latestRun
  const taskActive = latestRun !== undefined && runtimeRunIsActive(latestRun.status)
  const inputDisabled = busy || submitting
  const busyReason = busy
    ? session.activeWorkflowId !== undefined
      ? '会话有进行中的工作流实例：新输入在实例结束前被服务端拒绝（409 session-busy）。'
      : '会话有进行中的运行（排队/执行/等待审批或整理期间保持 busy）：新输入被服务端拒绝（409 session-busy）。'
    : undefined

  const submit = async () => {
    const text = draft.content
    const encoded = new TextEncoder().encode(text)
    if (encoded.length > INPUT_LIMIT_BYTES) {
      setErrorMessage(`输入内容超过 32 KiB 上限（当前 ${encoded.length} 字节）`)
      return
    }
    if (text.trim() === '') {
      setErrorMessage('输入内容不能为空')
      return
    }
    setErrorMessage(undefined)
    if (pending) {
      setErrorMessage('上次提交结果未确认，请先核对服务端状态。')
      return
    }
    let references: ReturnType<typeof collectReferences>
    try { references = collectReferences() }
    catch (error) { setErrorMessage(error instanceof Error ? error.message : '提示参数无效'); return }
    newRequestId()
    await withRequestId(async (requestId) => {
      const input: AgentInput = {
        requestId,
        content: text,
        ...(references.skills.length > 0 ? { skills: references.skills } : {}),
        ...(references.resources.length > 0 ? { resources: references.resources } : {}),
        ...(references.prompts.length > 0 ? { prompts: references.prompts } : {}),
      }
      try {
        const run = selectedTaskId === undefined
          ? await createTask(gateway, session.id, input)
          : await continueRunTask(gateway, selectedTaskId, input)
        notify({ tone: 'success', message: `已受理：第 ${run.runNumber} 轮运行（${selectedTaskId === undefined ? '新任务' : '续轮'}）` })
        updateDraft({ content: '' })
      } catch (error) {
        setPendingInput(draftKey, { sessionId: session.id, taskId: selectedTaskId, input, uncertain: true })
        setErrorMessage(error instanceof Error ? error.message : '提交失败')
      }
    })
  }

  const findPendingRun = async (): Promise<RuntimeRun | undefined> => {
    if (!pending) return undefined
    let cursor: string | undefined
    do {
      const page = await gateway.agentRuns.listRuns({ requestId: pending.input.requestId, sessionId: pending.sessionId, ...(pending.taskId ? { taskId: pending.taskId } : {}), ...(cursor ? { cursor } : {}) })
      const found = page.items.find((run) => run.requestId === pending.input.requestId && run.sessionId === pending.sessionId && (!pending.taskId || run.taskId === pending.taskId))
      if (found) return found
      if (!page.hasMore) return undefined
      if (!page.nextCursor || page.nextCursor === cursor) throw new Error('运行分页未前进，请重新核对提交状态。')
      cursor = page.nextCursor
    } while (true)
  }

  const showReconciledRun = async (run: RuntimeRun) => {
    if (!pending) return
    const store = useAgentWorkbenchStore.getState()
    if (store.selectedSessionId !== pending.sessionId || store.selectedTaskId !== pending.taskId) return
    if (run.taskId !== store.selectedTaskId) store.selectTask(run.taskId)
    store.selectRun(run.id)
    await Promise.all([store.loadSessionDetail(gateway), store.loadTasks(gateway), store.loadMessages(gateway, { incremental: true })])
  }

  const reconcilePending = async () => {
    if (!pending) return
    await inFlightOnly(async () => {
      try {
        const found = await findPendingRun()
        if (found) {
          await showReconciledRun(found)
          setPendingInput(draftKey, undefined)
          updateDraft({ content: '' })
          setErrorMessage(undefined)
          return
        }
        setErrorMessage('服务端暂未找到该 requestId；确认后可用原 requestId 显式重试。')
      } catch (error) { setErrorMessage(error instanceof Error ? error.message : '核对提交状态失败') }
    })
  }

  const retryPending = async () => {
    if (!pending) return
    await inFlightOnly(async () => {
      try {
        const found = await findPendingRun()
        if (!found) {
          if (pending.taskId) await continueRunTask(gateway, pending.taskId, pending.input)
          else await createTask(gateway, pending.sessionId, pending.input)
        } else {
          await showReconciledRun(found)
        }
        setPendingInput(draftKey, undefined)
        updateDraft({ content: '' })
        setErrorMessage(undefined)
      } catch (error) { setErrorMessage(error instanceof Error ? error.message : '重试失败') }
    })
  }

  const collectReferences = (): { skills: AgentRevisionRef[]; resources: AgentResourceRef[]; prompts: AgentPromptRef[] } => {
    const ref = (value: string): AgentRevisionRef => {
      const separator = value.lastIndexOf(':')
      return { id: value.slice(0, separator), revision: Number(value.slice(separator + 1)) }
    }
    return {
      skills: draft.skills.map(ref),
      resources: draft.resources.map((key): AgentResourceRef => {
        const separator = key.indexOf(':')
        return { serverId: key.slice(0, separator), uri: key.slice(separator + 1) }
      }),
      prompts: draft.prompts.map((key): AgentPromptRef => {
        const separator = key.indexOf('::')
        const raw = draft.promptArguments[key]?.trim() || '{}'
        const parsed: unknown = JSON.parse(raw)
        if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object' || Object.values(parsed).some((value) => typeof value !== 'string')) throw new Error('提示参数必须是仅含字符串值的 JSON 对象')
        return { serverId: key.slice(0, separator), name: key.slice(separator + 2), arguments: parsed as Record<string, string> }
      }),
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1 overflow-y-auto hover-scrollbar px-3 py-3">
        {selectedTaskId !== undefined && taskStatus === 'loading' && taskDetail === undefined ? <LoadingState label="正在加载任务…" /> : null}
        {selectedTaskId !== undefined && taskStatus === 'error' ? <ErrorState description={taskError} /> : null}
        {selectedTaskId !== undefined && taskDetail !== undefined ? (
          <p className="mb-3 rounded-lg border border-line bg-surface px-2 py-1.5 text-xs text-fg-muted">
            任务目标：{taskGoalOf(taskDetail)}（{taskDetail.id}）
            {taskActive ? ' · 运行进行中，结果以服务端为准' : ''}
          </p>
        ) : null}
        {messagesStatus === 'loading' && messages.length === 0 ? <LoadingState label="正在读取消息…" /> : null}
        {messagesStatus === 'error' && messages.length === 0 ? <ErrorState description={messagesError} /> : null}
        {messagesStatus !== 'loading' && taskMessages.length === 0 ? (
          <p className="py-6 text-center text-xs text-fg-subtle">
            {selectedTaskId === undefined ? '输入任务内容并「创建并运行」，第一轮对话从这里开始。' : '该任务还没有公开消息。'}
          </p>
        ) : null}
        <ol className="flex flex-col gap-3" aria-label="公开消息流">
          {taskMessages.map((message) => (
            <MessageRow key={message.id} message={message} />
          ))}
        </ol>
      </div>

      <form
        className="border-t border-line p-3"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        {busyReason ? (
          <p role="status" className="mb-2 rounded-lg border border-line bg-surface px-2 py-1.5 text-xs text-warning">{busyReason}</p>
        ) : null}
        <label htmlFor="workbench-task-input" className="block text-xs text-fg-muted">
          {selectedTaskId === undefined ? '新任务输入' : '继续任务输入'}
        </label>
        <textarea
          id="workbench-task-input"
          value={draft.content}
          onChange={(event) => updateDraft({ content: event.target.value })}
          disabled={inputDisabled}
          rows={3}
          placeholder={selectedTaskId === undefined ? '描述要 Ely 完成的任务（≤32 KiB）' : '补充新一轮的指示（≤32 KiB）'}
          className="ctl-field mt-1 w-full resize-y font-normal"
        />
        <button
          type="button"
          onClick={() => setReferencesOpen((value) => !value)}
          aria-expanded={referencesOpen}
          className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-fg-muted transition-colors hover:text-fg"
        >
          <ChevronDown aria-hidden size={12} className={referencesOpen ? 'rotate-180 transition-transform' : 'transition-transform'} />
          引用资料（技能 / 资源 / 提示）
        </button>
        {referencesOpen ? (
          <ReferencePicker
            catalog={catalog}
            gateway={gateway}
            disabled={inputDisabled}
            selectedSkills={draft.skills}
            selectedResources={draft.resources}
            selectedPrompts={draft.prompts}
            promptArguments={draft.promptArguments}
            onSkills={(skills) => updateDraft({ skills })}
            onResources={(resources) => updateDraft({ resources })}
            onPrompts={(prompts) => updateDraft({ prompts })}
            onPromptArguments={(key, value) => updateDraft({ promptArguments: { ...draft.promptArguments, [key]: value } })}
          />
        ) : null}
        {errorMessage ? <p role="alert" className="mt-2 text-xs text-danger">{errorMessage}</p> : null}
        {pending ? <div role="status" className="mt-2 flex flex-wrap items-center gap-2 text-xs text-warning">提交结果未确认（requestId {pending.input.requestId}）。<button type="button" onClick={() => void reconcilePending()} disabled={submitting} className="underline">核对状态</button><button type="button" onClick={() => void retryPending()} disabled={submitting} className="underline">用原 ID 重试</button></div> : null}
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-[10px] text-fg-subtle">requestId 仅用于本次提交的幂等回读；重复提交回读原结果。</span>
          <button
            type="submit"
            disabled={inputDisabled || !!pending}
            className="rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:border-fg-subtle disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? '正在提交…' : selectedTaskId === undefined ? '创建并运行' : '继续任务'}
          </button>
        </div>
      </form>
    </div>
  )
}

function MessageRow({ message }: { message: AgentMessage }) {
  const quarantined = message.quarantined === true
  return (
    <li className={`rounded-lg border px-3 py-2 text-sm ${message.role === 'user' ? 'border-line bg-surface' : 'border-line'}`}>
      <div className="mb-1 flex items-center gap-2 text-[10px] text-fg-subtle">
        <span className="font-medium text-fg-muted">{message.role === 'user' ? '用户' : 'Ely'}</span>
        <span className="tabular-nums" title="消息序号（十进制字符串）">#{message.seq}</span>
        <span>{formatDateTime(message.createdAt)}</span>
        {message.runStatus ? <AgentRunStatusTag status={message.runStatus} /> : null}
      </div>
      {quarantined ? (
        <p className="rounded border border-warning/40 bg-warning/10 px-2 py-1.5 text-xs text-warning" role="note">
          来源已撤回，内容已隔离：该答复引用了不可信或未核实内容，正文不再展示。
        </p>
      ) : (
        <p className="whitespace-pre-wrap break-words text-fg">{message.content}</p>
      )}
      {message.wikiSources !== undefined && message.wikiSources.length > 0 ? (
        <p className="mt-1.5 text-[10px] text-fg-subtle">
          引用：{message.wikiSources.map((source) => `${source.pageId}（修订 ${source.revision}）`).join('、')}
        </p>
      ) : null}
    </li>
  )
}

function ReferenceCheckbox({ checked, label, hint, disabled, onToggle }: { checked: boolean; label: string; hint?: string; disabled?: boolean; onToggle(): void }) {
  return (
    <label className={`flex items-start gap-2 rounded px-1 py-1 text-xs ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-surface-raised'}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={() => onToggle()} className="mt-0.5 size-3.5 accent-[var(--color-accent)]" />
      <span className="min-w-0">
        <span className="block break-all text-fg">{label}</span>
        {hint ? <span className="block text-fg-subtle">{hint}</span> : null}
      </span>
    </label>
  )
}

function toggleIn(list: readonly string[], value: string): readonly string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value]
}

function ReferencePicker({
  catalog,
  gateway,
  disabled,
  selectedSkills,
  selectedResources,
  selectedPrompts,
  promptArguments,
  onSkills,
  onResources,
  onPrompts,
  onPromptArguments,
}: {
  catalog: ReturnType<typeof useReferenceCatalog>
  gateway: ElysianGateway
  disabled?: boolean
  selectedSkills: readonly string[]
  selectedResources: readonly string[]
  selectedPrompts: readonly string[]
  promptArguments: Record<string, string>
  onSkills(next: readonly string[]): void
  onResources(next: readonly string[]): void
  onPrompts(next: readonly string[]): void
  onPromptArguments(key: string, value: string): void
}) {
  const readyServers = catalog.servers.filter((server) => server.catalogStatus === 'ready' && server.catalog !== undefined)
  return (
    <div className="mt-1.5 flex flex-col gap-2 rounded-lg border border-line p-2">
      {catalog.status === 'loading' ? <p className="text-xs text-fg-subtle">正在读取技能与 MCP 目录…</p> : null}
      {catalog.status === 'error' ? <p role="alert" className="text-xs text-danger">{catalog.error}</p> : null}
      {catalog.status === 'ready' ? (
        <>
          <div>
            <p className="mb-0.5 text-[11px] font-medium text-fg-muted">技能（按修订引用）</p>
            {catalog.skills.length === 0 ? <p className="text-xs text-fg-subtle">没有已导入的技能。</p> : null}
            {catalog.skills.map((skill) => (
              <ReferenceCheckbox
                key={`${skill.id}:${skill.revision}`}
                checked={selectedSkills.includes(`${skill.id}:${skill.revision}`)}
                disabled={disabled}
                label={skill.label}
                hint={skill.description}
                onToggle={() => onSkills(toggleIn(selectedSkills, `${skill.id}:${skill.revision}`))}
              />
            ))}
          </div>
          {catalog.servers.map((server) => (
            <div key={server.id}>
              <p className="mb-0.5 flex items-center gap-2 text-[11px] font-medium text-fg-muted">
                {server.label}
                {server.catalogStatus === 'idle' ? (
                  <button type="button" className="text-[10px] text-accent-fg underline underline-offset-2" onClick={() => void catalog.ensureCatalog(gateway, server.id)}>
                    读取目录
                  </button>
                ) : null}
                {server.catalogStatus === 'loading' ? <span className="text-[10px] text-fg-subtle">读取中…</span> : null}
                {server.catalogStatus === 'error' ? <span className="text-[10px] text-danger" role="alert">{server.catalogError}</span> : null}
              </p>
              {server.catalog !== undefined ? (
                <div className="flex flex-col">
                  {server.catalog.resources.map((resource) => (
                    <ReferenceCheckbox
                      key={`${server.id}:${resource.uri}`}
                      checked={selectedResources.includes(`${server.id}:${resource.uri}`)}
                      disabled={disabled}
                      label={resource.name}
                      hint={resource.uri}
                      onToggle={() => onResources(toggleIn(selectedResources, `${server.id}:${resource.uri}`))}
                    />
                  ))}
                  {server.catalog.prompts.map((prompt) => {
                    const key = `${server.id}::${prompt.name}`
                    return <div key={key}><ReferenceCheckbox checked={selectedPrompts.includes(key)} disabled={disabled} label={`提示：${prompt.title ?? prompt.name}`} hint={prompt.description ?? undefined} onToggle={() => onPrompts(toggleIn(selectedPrompts, key))} />
                      {selectedPrompts.includes(key) ? <label className="ml-5 block text-[11px] text-fg-muted">提示参数 JSON（字符串键值）<textarea value={promptArguments[key] ?? '{}'} onChange={(event) => onPromptArguments(key, event.target.value)} disabled={disabled} rows={2} className="ctl-field mt-1 w-full resize-y font-mono text-[11px]" /></label> : null}
                    </div>
                  })}
                </div>
              ) : null}
            </div>
          ))}
          {readyServers.length === 0 && catalog.skills.length === 0 ? null : null}
        </>
      ) : null}
    </div>
  )
}
