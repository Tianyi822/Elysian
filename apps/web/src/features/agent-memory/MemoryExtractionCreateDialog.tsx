import { useEffect, useRef, useState } from 'react'
import type { AgentCreateMemoryExtractionInput } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { CTL_PRIMARY, CTL_SECONDARY } from '../../components/formControl'
import { SelectDropdown } from '../../components/SelectDropdown'
import { useInFlightSubmit } from '../../components/agent/useInFlightSubmit'
import { useNotificationStore } from '../../stores/notificationStore'
import { useAgentMemoryStore } from '../../stores/agentMemoryStore'
import { MemoryDialog } from './MemoryDialog'

/*
 * 手工提炼创建：runId 或 workflowId 互斥（服务端 CreateWikiExtraction 校验），
 * WikiExtractionInput 带 requestId（白名单七类，useInFlightSubmit.withRequestId）；
 * 202 新建 / 200 重复幂等回读，队列满 429 透传中文提示。
 * 候选来源下拉经 gateway 只读消费运行记录域与工作流域的成功实体；读取失败时
 * 回落为手填编号，不阻塞提交。
 */
type SourceKind = 'run' | 'workflow'

export function MemoryExtractionCreateDialog({ onClose }: { onClose(): void }) {
  const gateway = useGateway()
  const createExtraction = useAgentMemoryStore((state) => state.createExtraction)
  const { submitting, withRequestId, inFlightOnly, newRequestId } = useInFlightSubmit()
  const [kind, setKind] = useState<SourceKind>('run')
  const [runOptions, setRunOptions] = useState<readonly { value: string; label: string }[]>([])
  const [workflowOptions, setWorkflowOptions] = useState<readonly { value: string; label: string }[]>([])
  const [optionsError, setOptionsError] = useState<string>()
  const [runId, setRunId] = useState<string | undefined>(undefined)
  const [workflowId, setWorkflowId] = useState<string | undefined>(undefined)
  const [manualInput, setManualInput] = useState('')
  const [errorMessage, setErrorMessage] = useState<string>()
  const currentSubmission = useRef<{ signature: string; requestId: string } | undefined>(undefined)
  const [uncertain, setUncertain] = useState<AgentCreateMemoryExtractionInput[]>([])
  const [relatedJobs, setRelatedJobs] = useState<string[]>([])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const runs = await gateway.agentRuns.listRuns({ status: 'succeeded', limit: 50 })
        const workflows = await gateway.agentWorkflows.listInstances({ status: 'succeeded' })
        if (cancelled) return
        setRunOptions(runs.items.map((run) => ({ value: run.id, label: `${run.id}（${run.status}）` })))
        setWorkflowOptions(workflows.items.map((instance) => ({ value: instance.id, label: `${instance.id}（${instance.currentStepId ?? '已完成'}）` })))
      } catch (error) {
        if (cancelled) return
        setOptionsError(error instanceof Error ? error.message : '读取可提炼来源失败，可直接手填编号')
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [gateway])

  const options = kind === 'run' ? runOptions : workflowOptions
  const selected = kind === 'run' ? runId : workflowId
  const effectiveId = options.length > 0 ? selected : (manualInput.trim() === '' ? undefined : manualInput.trim())

  const handleFailure = async (input: AgentCreateMemoryExtractionInput, error: unknown) => {
    setUncertain((items) => [input, ...items.filter((item) => item.requestId !== input.requestId)])
    try {
      const page = await gateway.agentMemory.listExtractions()
      setRelatedJobs(page.items.filter((job) => input.runId !== undefined
        ? job.runId === input.runId || (job.originKind === 'run' && job.originId === input.runId)
        : job.workflowId === input.workflowId || (job.originKind === 'workflow' && job.originId === input.workflowId)).map((job) => job.id))
    } catch {
      setRelatedJobs([])
    }
    const message = error instanceof Error ? error.message : '提交提炼任务失败'
    setErrorMessage(`${message}；来源匹配不能确认是本次请求，可按原输入重试。`)
    useNotificationStore.getState().notify({ tone: 'danger', message })
  }

  const submit = async () => {
    if (effectiveId === undefined) {
      setErrorMessage(kind === 'run' ? '请选择或填写成功的运行编号' : '请选择或填写成功的工作流编号')
      return
    }
    const payload = kind === 'run' ? { runId: effectiveId } : { workflowId: effectiveId }
    const signature = JSON.stringify(payload)
    if (currentSubmission.current !== undefined && currentSubmission.current.signature !== signature) newRequestId()
    await withRequestId(async (requestId) => {
      currentSubmission.current = { signature, requestId }
      const input: AgentCreateMemoryExtractionInput = { requestId, ...payload }
      try {
        await createExtraction(gateway, input)
        setUncertain((items) => items.filter((item) => item.requestId !== requestId))
        onClose()
      } catch (error) {
        await handleFailure(input, error)
      }
    })
  }

  const retry = async (input: AgentCreateMemoryExtractionInput) => {
    await inFlightOnly(async () => {
      try {
        await createExtraction(gateway, input)
        setUncertain((items) => items.filter((item) => item.requestId !== input.requestId))
        onClose()
      } catch (error) {
        await handleFailure(input, error)
      }
    })
  }

  return (
    <MemoryDialog title="手工创建提炼任务" onClose={onClose}>
      <p className="text-xs leading-5 text-fg-muted">
        只接受「成功的普通 Agent 运行」或「成功的根工作流」且来源需有提炼快照；
        requestId 保证重复提交幂等（202 新建 / 200 回读既有任务）。
      </p>
      <fieldset className="mt-3">
        <legend className="text-xs text-fg-muted">来源类型（二选一）</legend>
        <div className="mt-1 flex gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="memory-extraction-source"
              checked={kind === 'run'}
              onChange={() => {
                setKind('run')
                setWorkflowId(undefined)
                setManualInput('')
              }}
            />
            成功的 Agent 运行
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="memory-extraction-source"
              checked={kind === 'workflow'}
              onChange={() => {
                setKind('workflow')
                setRunId(undefined)
                setManualInput('')
              }}
            />
            成功的根工作流
          </label>
        </div>
      </fieldset>
      <div className="mt-3">
        {options.length > 0 ? (
          <>
            <span id="memory-extraction-source-label" className="block text-xs text-fg-muted">
              {kind === 'run' ? '运行编号' : '工作流编号'}
            </span>
            <div className="mt-1">
              <SelectDropdown
                ariaLabel={kind === 'run' ? '运行编号' : '工作流编号'}
                items={options}
                value={selected}
                onSelect={(value) => { (kind === 'run' ? setRunId : setWorkflowId)(value) }}
                fallbackLabel="请选择"
                fullWidth
                mono
              />
            </div>
          </>
        ) : (
          <>
            <label htmlFor="memory-extraction-manual" className="block text-xs text-fg-muted">
              {kind === 'run' ? '运行编号' : '工作流编号'}（列表不可用，手填）
            </label>
            <input
              id="memory-extraction-manual"
              value={manualInput}
              onChange={(event) => { setManualInput(event.target.value) }}
              className="mt-1 h-9 w-full rounded-lg border border-line bg-surface px-3 font-mono text-sm text-fg"
            />
          </>
        )}
        {optionsError !== undefined ? <p role="status" className="mt-1 text-xs text-fg-subtle">{optionsError}</p> : null}
      </div>
      {errorMessage ? <p role="alert" className="mt-2 text-xs text-danger">{errorMessage}</p> : null}
      {relatedJobs.length > 0 ? <p className="mt-1 text-xs text-fg-muted">同来源任务：{relatedJobs.join('、')}。公开任务记录不含 requestId，不能据此确认本次提交。</p> : null}
      {uncertain.length > 0 ? (
        <div className="mt-2 space-y-1 text-xs text-fg-muted">
          {uncertain.map((input) => (
            <div key={input.requestId} className="flex flex-wrap items-center gap-2">
              <span className="font-mono break-all">{input.requestId} · {input.runId ?? input.workflowId}</span>
              <button type="button" className="text-info underline underline-offset-2" disabled={submitting} onClick={() => void retry(input)}>按原来源重试</button>
            </div>
          ))}
        </div>
      ) : null}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className={CTL_SECONDARY} onClick={onClose}>取消</button>
        <button type="button" className={CTL_PRIMARY} disabled={submitting} onClick={() => void submit()}>
          提交提炼任务
        </button>
      </div>
    </MemoryDialog>
  )
}
