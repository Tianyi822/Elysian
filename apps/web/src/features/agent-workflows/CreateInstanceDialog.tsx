import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import * as Dialog from '@radix-ui/react-dialog'
import type { AgentCreateWorkflowInput, AgentWorkflowDefinition, AgentWorkflowInstance } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { useInFlightSubmit } from '../../components/agent/useInFlightSubmit'
import { CTL_PRIMARY, CTL_SECONDARY } from '../../components/formControl'
import { useNotificationStore } from '../../stores/notificationStore'
import { useAgentWorkflowsStore } from '../../stores/agentWorkflowsStore'
import { checkJsonAgainstSchemaLite, precheckInstanceInputText } from './workflowJsonPrecheck'

/**
 * 从模板创建实例：CreateWorkflowInput 带 requestId（白名单七类之一，用
 * withRequestId 档）——同一次打开内重试/连点复用同一幂等键，刷新后绝不重放。
 * 实例固定来源会话的模型修订与能力环境快照（不复制来源历史或文件），此处向
 * 操作者显式说明。inputJson 重复键/超限由前端预检，Schema 尽力校验以服务端为准。
 */
export function CreateInstanceDialog({
  definition,
  onClose,
  onCreated,
}: {
  definition: AgentWorkflowDefinition
  onClose(): void
  onCreated(instanceId: string): void
}) {
  const gateway = useGateway()
  const notify = useNotificationStore((state) => state.notify)
  const createInstance = useAgentWorkflowsStore((state) => state.createInstance)
  const { submitting, withRequestId, inFlightOnly, newRequestId } = useInFlightSubmit()
  const [, setSearchParams] = useSearchParams()
  const [sourceSessionId, setSourceSessionId] = useState('')
  const [inputJson, setInputJson] = useState('{\n  \n}')
  const [errorMessage, setErrorMessage] = useState<string>()
  const [schemaWarning, setSchemaWarning] = useState<string>()
  const currentSubmission = useRef<{ signature: string; requestId: string } | undefined>(undefined)
  const [uncertain, setUncertain] = useState<AgentCreateWorkflowInput[]>([])

  useEffect(() => {
    // 每次打开都作废旧幂等键：不同轮次的提交内容可能不同。
    newRequestId()
    setErrorMessage(undefined)
    setSchemaWarning(undefined)
  }, [newRequestId])

  const created = (instance: AgentWorkflowInstance) => {
    setUncertain((items) => items.filter((item) => item.requestId !== instance.requestId))
    notify({ tone: 'success', message: `实例 ${instance.id} 已提交创建（${instance.status === 'ready' ? '待推进' : '已排队'}）` })
    setSearchParams((previous) => {
      const params = new URLSearchParams(previous)
      params.set('view', 'instances')
      params.set('instanceId', instance.id)
      return params
    })
    onCreated(instance.id)
  }

  const reconcile = async (input: AgentCreateWorkflowInput, error: unknown) => {
    try {
      let cursor: string | undefined
      for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
        const page = await gateway.agentWorkflows.listInstances({ cursor, limit: 50 })
        const match = page.items.find((item) => item.requestId === input.requestId)
        if (match !== undefined) {
          created(match)
          return
        }
        if (!page.hasMore || page.nextCursor === '' || page.nextCursor === cursor) break
        cursor = page.nextCursor
      }
    } catch {
      // The exact same request remains available for retry if the read also fails.
    }
    setUncertain((items) => [input, ...items.filter((item) => item.requestId !== input.requestId)])
    setErrorMessage(`${error instanceof Error ? error.message : '创建工作流实例失败'}；结果未确认，可用原请求重试。`)
  }

  const submit = async () => {
    if (!sourceSessionId.trim()) {
      setErrorMessage('必须提供来源会话 ID：实例将复制该会话固定的模型修订与能力环境快照')
      return
    }
    const precheck = precheckInstanceInputText(inputJson)
    if (precheck !== null) {
      setErrorMessage(precheck)
      return
    }
    const schemaIssue = checkJsonAgainstSchemaLite(inputJson, definition.inputSchemaJson)
    if (schemaIssue !== null) {
      setSchemaWarning(`尽力校验提示：${schemaIssue}（以服务端校验为准）`)
    }
    const payload = {
      definitionId: definition.id,
      definitionRevision: definition.revision,
      sourceSessionId: sourceSessionId.trim(),
      inputJson,
    }
    const signature = JSON.stringify(payload)
    if (currentSubmission.current !== undefined && currentSubmission.current.signature !== signature) newRequestId()
    await withRequestId(async (requestId) => {
      currentSubmission.current = { signature, requestId }
      const input = { requestId, ...payload }
      try {
        created(await createInstance(gateway, input))
      } catch (error) {
        await reconcile(input, error)
      }
    })
  }

  const retry = async (input: AgentCreateWorkflowInput) => {
    await inFlightOnly(async () => {
      try {
        created(await createInstance(gateway, input))
      } catch (error) {
        await reconcile(input, error)
      }
    })
  }

  return (
    <Dialog.Root open onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[61] flex max-h-[85vh] w-[min(40rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col panel-surface p-4 shadow-xl"
        >
          <Dialog.Title className="text-sm font-semibold">从模板「{definition.name}」创建实例</Dialog.Title>
          <p className="mt-1 text-xs text-fg-muted">
            固定模板修订 {definition.revision}。实例将复制来源会话固定的模型修订与能力环境快照（技能、MCP、
            授权与显式 trustedReadOnly），不复制来源会话的历史消息或文件；同一 requestId 重复提交按幂等回读。
          </p>
          <div className="mt-3 grid gap-3">
            <div>
              <label htmlFor="workflow-create-source-session" className="block text-xs text-fg-muted">
                来源会话 ID（sourceSessionId）
              </label>
              <input
                id="workflow-create-source-session"
                value={sourceSessionId}
                onChange={(event) => setSourceSessionId(event.target.value)}
                placeholder="例如 sess-…（在 Ely 工作台选择会话后复制）"
                className="mt-1 h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm text-fg"
              />
            </div>
            <div>
              <label htmlFor="workflow-create-input" className="block text-xs text-fg-muted">
                实例输入 JSON（按模板 inputSchemaJson 校验）
              </label>
              <textarea
                id="workflow-create-input"
                value={inputJson}
                onChange={(event) => setInputJson(event.target.value)}
                spellCheck={false}
                className="mt-1 min-h-[9rem] resize-y rounded-lg border border-line bg-surface p-3 font-mono text-xs text-fg"
              />
              <p className="mt-1 break-all text-xs text-fg-subtle">Schema：{definition.inputSchemaJson}</p>
            </div>
          </div>
          {schemaWarning ? <p className="mt-2 text-xs text-warning">{schemaWarning}</p> : null}
          {errorMessage ? (
            <p role="alert" className="mt-2 text-xs text-danger">
              {errorMessage}
            </p>
          ) : null}
          {uncertain.length > 0 ? (
            <div className="mt-2 space-y-1 text-xs text-fg-muted">
              {uncertain.map((input) => (
                <div key={input.requestId} className="flex flex-wrap items-center gap-2">
                  <span className="font-mono break-all">{input.requestId} · {input.sourceSessionId}</span>
                  <button type="button" className="text-info underline underline-offset-2" disabled={submitting} onClick={() => void retry(input)}>按原输入重试</button>
                </div>
              ))}
            </div>
          ) : null}
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" className={CTL_SECONDARY} onClick={onClose} disabled={submitting}>
              取消
            </button>
            <button type="button" className={CTL_PRIMARY} disabled={submitting} onClick={() => void submit()}>
              {submitting ? '提交中…' : '创建并推进'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
