import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import * as Dialog from '@radix-ui/react-dialog'
import { AGENT_WORKFLOW_RECOVERY_ACTIONS, AGENT_WORKFLOW_RECOVERY_ACTION_LABELS } from '@elysian/contracts'
import type { AgentWorkflowInstance, AgentWorkflowNodeExecution, AgentWorkflowRecoveryAction, AgentWorkflowRecoveryInput } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { AgentHttpError } from '../../adapters/http/agent/agentShared'
import { useInFlightSubmit } from '../../components/agent/useInFlightSubmit'
import { CTL_CHIP, CTL_PRIMARY, CTL_SECONDARY } from '../../components/formControl'
import { useAgentWorkflowsStore } from '../../stores/agentWorkflowsStore'
import { checkJsonAgainstSchemaLite } from './workflowJsonPrecheck'

const ACTION_DESCRIPTIONS: Record<AgentWorkflowRecoveryAction, string> = {
  continue: '只能从维护冻结的已确认边界继续；不重跑任何调用。',
  'renew-approval': '原审批已撤销时重新申请；已派发操作不能重用原审批。',
  retry: '重新派发该步骤：旧 Run/Call 记录保持不变，新尝试计入每步上限。',
  'accept-result': '以人工核实的外部结果补录完成；confirmed-stopped 的节点不提供此动作。',
}

/**
 * 人工恢复对话框：动作只按服务端 allowedActions 点亮（前端禁用仅是交互反馈，
 * 裁决在后端）；必填 evidence，workflow/v2 的 nodeId 取执行树所选节点，
 * accept-result 需 outputJson（尽力按 Schema 校验，以服务端为准）；显示
 * expectedRevision，409 revision-conflict 时回读新修订，409 execution-barrier
 * 时给出治理中心深链。提交体只含 {requestId,expectedRevision,action,evidence,
 * nodeId?,outputJson?}，requestId 用 withRequestId 档复用（刷新后绝不重放）。
 */
export function RecoveryDialog({
  instance,
  nodes,
  defaultNodeId,
  outputSchemaJson,
  onClose,
  onRecovered,
}: {
  instance: AgentWorkflowInstance
  nodes: readonly AgentWorkflowNodeExecution[]
  defaultNodeId: string
  outputSchemaJson?: string
  onClose(): void
  onRecovered(): void
}) {
  const gateway = useGateway()
  const recover = useAgentWorkflowsStore((state) => state.recoverInstance)
  const refresh = useAgentWorkflowsStore((state) => state.refreshInstance)
  const { submitting, withRequestId, inFlightOnly, newRequestId } = useInFlightSubmit()
  const isV2 = instance.languageVersion === 'workflow/v2'
  const [action, setAction] = useState<AgentWorkflowRecoveryAction | undefined>(undefined)
  const node = nodes.find((item) => item.id === defaultNodeId)
  const allowed = isV2 ? node?.allowedActions ?? [] : instance.allowedActions
  const [evidence, setEvidence] = useState('')
  const [outputJson, setOutputJson] = useState('')
  const [errorMessage, setErrorMessage] = useState<string>()
  const [errorCode, setErrorCode] = useState<string>()
  const [schemaWarning, setSchemaWarning] = useState<string>()
  const currentSubmission = useRef<{ signature: string; requestId: string } | undefined>(undefined)
  const [uncertain, setUncertain] = useState<{ instanceId: string; input: AgentWorkflowRecoveryInput }[]>([])

  useEffect(() => {
    // 每次打开生成新幂等键；同一对话框内的重试复用它（断网重连不重复提交）。
    newRequestId()
  }, [newRequestId, instance.id, defaultNodeId])

  useEffect(() => {
    if (action === undefined || !allowed.includes(action)) setAction(allowed[0])
  }, [action, allowed])

  const recovered = (requestId: string) => {
    setUncertain((items) => items.filter((item) => item.input.requestId !== requestId))
    onRecovered()
  }

  const handleFailure = async (instanceId: string, input: AgentWorkflowRecoveryInput, error: unknown) => {
    const message = error instanceof Error ? error.message : '恢复工作流失败'
    setErrorCode(error instanceof AgentHttpError ? error.code : undefined)
    setUncertain((items) => [{ instanceId, input }, ...items.filter((item) => item.input.requestId !== input.requestId)])
    try {
      const latest = await gateway.agentWorkflows.getInstance(instanceId)
      setErrorMessage(`${message}；当前修订 ${latest.revision}，无法从读取结果确认该请求是否已生效，请核对后按原输入重试。`)
      await refresh(gateway)
    } catch {
      setErrorMessage(`${message}；结果未确认，可按原输入重试。`)
    }
  }

  const submit = async () => {
    if (action === undefined || !allowed.includes(action)) {
      setErrorMessage('必须选择一个恢复动作；可用动作由服务端 allowedActions 决定')
      return
    }
    if (evidence.trim() === '') {
      setErrorMessage('必须提供核实说明（evidence）：描述你依据什么外部证据做出该决定')
      return
    }
    if (new TextEncoder().encode(evidence).length > 8_192) {
      setErrorMessage('核实说明不得超过 8192 字节')
      return
    }
    if (isV2 && defaultNodeId.trim() === '') {
      setErrorMessage('恢复 workflow/v2 必须先从执行树选择节点')
      return
    }
    if (isV2 && node === undefined) {
      setErrorMessage('节点不存在或执行树尚未就绪，请刷新实例后重试')
      return
    }
    if (action === 'accept-result') {
      if (outputJson.trim() === '') {
        setErrorMessage('补录已确认结果必须提供 outputJson')
        return
      }
      try {
        JSON.parse(outputJson)
      } catch {
        setErrorMessage('outputJson 不是有效 JSON')
        return
      }
      if (outputSchemaJson !== undefined) {
        const issue = checkJsonAgainstSchemaLite(outputJson, outputSchemaJson)
        setSchemaWarning(issue === null ? undefined : `尽力校验提示：${issue}（以服务端校验为准）`)
        if (issue !== null) return
      }
    }
    const payload = {
      expectedRevision: instance.revision,
      action,
      evidence: evidence.trim(),
      ...(isV2 ? { nodeId: defaultNodeId } : {}),
      ...(action === 'accept-result' ? { outputJson } : {}),
    }
    const signature = JSON.stringify({ instanceId: instance.id, ...payload })
    if (currentSubmission.current !== undefined && currentSubmission.current.signature !== signature) newRequestId()
    await withRequestId(async (requestId) => {
      currentSubmission.current = { signature, requestId }
      const input = { requestId, ...payload }
      try {
        await recover(gateway, instance.id, input)
        recovered(requestId)
      } catch (error) {
        await handleFailure(instance.id, input, error)
      }
    })
  }

  const retry = async (instanceId: string, input: AgentWorkflowRecoveryInput) => {
    await inFlightOnly(async () => {
      try {
        await recover(gateway, instanceId, input)
        recovered(input.requestId)
      } catch (error) {
        await handleFailure(instanceId, input, error)
      }
    })
  }

  return (
    <Dialog.Root open onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[61] flex max-h-[85vh] w-[min(42rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col panel-surface p-4 shadow-xl"
        >
          <Dialog.Title className="text-sm font-semibold">
            人工恢复实例 {instance.id}
            {node !== undefined ? ` · 节点 ${node.stepId}` : ''}
          </Dialog.Title>
          <p className="mt-1 text-xs text-fg-muted">
            当前状态修订（expectedRevision）：<span className="tabular-nums font-medium text-fg">{instance.revision}</span>
            ；恢复动作按服务端 allowedActions 展示，前端只做交互反馈；恢复不重置预算用量。
          </p>
          <div className="mt-3 flex flex-col gap-3 overflow-y-auto">
            <fieldset>
              <legend className="mb-1.5 text-xs text-fg-muted">恢复动作（四选一，仅可用动作可点）</legend>
              <div className="flex flex-col gap-1.5">
                {AGENT_WORKFLOW_RECOVERY_ACTIONS.map((value) => {
                  const enabled = allowed.includes(value)
                  return (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={action === value}
                      disabled={!enabled || submitting}
                      onClick={() => setAction(value)}
                      title={enabled ? ACTION_DESCRIPTIONS[value] : `服务端未开放该动作：${ACTION_DESCRIPTIONS[value]}`}
                      className={`${CTL_CHIP} justify-start text-left ${enabled ? '' : 'cursor-not-allowed opacity-50'}`}
                    >
                      {AGENT_WORKFLOW_RECOVERY_ACTION_LABELS[value]}
                      {enabled ? '' : '（不可用）'}
                    </button>
                  )
                })}
              </div>
            </fieldset>
            {isV2 ? <p className="break-all text-xs text-fg-muted">执行树所选节点：<span className="font-mono text-fg">{defaultNodeId || '未选择'}</span></p> : null}
            <div>
              <label htmlFor="workflow-recovery-evidence" className="block text-xs text-fg-muted">
                核实说明（evidence，必填，1 至 8192 字节）
              </label>
              <textarea
                id="workflow-recovery-evidence"
                value={evidence}
                onChange={(event) => setEvidence(event.target.value)}
                placeholder="例如：已在模型提供方控制台确认故障已排除 / 已在目标机器核实容器产物存在"
                className="mt-1 min-h-[5rem] resize-y rounded-lg border border-line bg-surface p-3 text-xs text-fg"
              />
            </div>
            {action === 'accept-result' ? (
              <div>
                <label htmlFor="workflow-recovery-output" className="block text-xs text-fg-muted">
                  补录结果 outputJson（必填；按步骤输出 Schema 尽力校验，以服务端校验为准）
                </label>
                <textarea
                  id="workflow-recovery-output"
                  value={outputJson}
                  onChange={(event) => setOutputJson(event.target.value)}
                  spellCheck={false}
                  className="mt-1 min-h-[6rem] resize-y rounded-lg border border-line bg-surface p-3 font-mono text-xs text-fg"
                />
                {outputSchemaJson !== undefined ? (
                  <p className="mt-1 break-all text-xs text-fg-subtle">Schema：{outputSchemaJson}</p>
                ) : null}
              </div>
            ) : null}
          </div>
          {schemaWarning ? <p className="mt-2 text-xs text-warning">{schemaWarning}</p> : null}
          {errorMessage ? (
            <div role="alert" className="mt-2 flex flex-col gap-1 text-xs text-danger">
              <p>{errorMessage}</p>
              {errorCode === 'revision-conflict' ? (
                <p>工作流状态版本已变化：已回读最新修订（现在为 {instance.revision}），请核对后重试。</p>
              ) : null}
              {errorCode === 'execution-barrier' ? (
                <p className="flex flex-col gap-1">
                  <span>存在未核实的执行屏障：必须先在治理中心把 unknown 屏障核实为 confirmed-completed / confirmed-stopped，恢复才会放行。</span>
                  <Link to="/agent/approvals?tab=barriers" className="text-info underline underline-offset-2">
                    前往 /agent/approvals?tab=barriers 核实屏障
                  </Link>
                </p>
              ) : null}
            </div>
          ) : null}
          {uncertain.length > 0 ? (
            <div className="mt-2 space-y-1 text-xs text-fg-muted">
              {uncertain.map(({ instanceId, input }) => (
                <div key={input.requestId} className="flex flex-wrap items-center gap-2">
                  <span className="font-mono break-all">{input.requestId} · {input.action} · r{input.expectedRevision}</span>
                  <button type="button" className="text-info underline underline-offset-2" disabled={submitting} onClick={() => void retry(instanceId, input)}>按原输入重试</button>
                </div>
              ))}
            </div>
          ) : null}
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" className={CTL_SECONDARY} onClick={onClose} disabled={submitting}>取消</button>
            <button type="button" className={CTL_PRIMARY} disabled={submitting || action === undefined} onClick={() => void submit()}>
              {submitting ? '提交中…' : action === undefined ? '请选择动作' : `提交恢复（${AGENT_WORKFLOW_RECOVERY_ACTION_LABELS[action]}）`}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
