import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import * as Dialog from '@radix-ui/react-dialog'
import { useGateway } from '../../adapters/GatewayProvider'
import { AgentWorkflowStatusTag } from '../../components/agent/AgentStatusTag'
import { JsonView } from '../../components/agent/JsonView'
import { useInFlightSubmit } from '../../components/agent/useInFlightSubmit'
import { useSilentPolling } from '../../components/agent/useSilentPolling'
import { BusyVeil, RefreshButton } from '../../components/RefreshState'
import { LoadingState, ErrorState } from '../../components/states/StateViews'
import { CTL_DANGER, CTL_PRIMARY, CTL_SECONDARY } from '../../components/formControl'
import { formatDateTime } from '../../components/format'
import { CornerDownRight, TriangleAlert } from '../../components/icons'
import { useNotificationStore } from '../../stores/notificationStore'
import { selectInstancePolling, useAgentWorkflowsStore } from '../../stores/agentWorkflowsStore'
import { ExecutionTreeView } from './ExecutionTreeView'
import { RecoveryDialog } from './RecoveryDialog'
import { WorkflowRecordsView } from './WorkflowRecordsView'
import { workflowUsageRows } from './workflowFormat'

/**
 * 实例详情：概要（状态、limits vs usage 五维、lastSeq、来源会话）、执行树
 * （v2 Scope 折叠树 / v1 单链）、步骤尝试与事件分页、取消与人工恢复。
 * 非终态实例 3s 静默轮询推进；「已请求取消」与「已取消」严格分栏。
 */
export function InstanceDetailSection({ instanceId }: { instanceId: string }) {
  const gateway = useGateway()
  const navigate = useNavigate()
  const notify = useNotificationStore((state) => state.notify)
  const [searchParams] = useSearchParams()
  const nodeId = searchParams.get('nodeId') ?? ''
  const status = useAgentWorkflowsStore((state) => state.detail.status)
  const instance = useAgentWorkflowsStore((state) => state.detail.instance)
  const tree = useAgentWorkflowsStore((state) => state.detail.tree)
  const errorMessage = useAgentWorkflowsStore((state) => state.detail.errorMessage)
  const reloading = useAgentWorkflowsStore((state) => state.detail.reloading)
  const definition = useAgentWorkflowsStore((state) => state.definitionDetail.definition)
  const select = useAgentWorkflowsStore((state) => state.selectInstance)
  const refresh = useAgentWorkflowsStore((state) => state.refreshInstance)
  const loadDefinition = useAgentWorkflowsStore((state) => state.loadDefinitionDetail)
  const cancel = useAgentWorkflowsStore((state) => state.cancelInstance)
  const { submitting: cancelling, inFlightOnly } = useInFlightSubmit()
  const [cancelOpen, setCancelOpen] = useState(false)
  const [recoveryNodeId, setRecoveryNodeId] = useState<string | undefined>(undefined)
  const [recoveryOpen, setRecoveryOpen] = useState(false)
  const selectedRecoveryNodeId = recoveryNodeId ?? (nodeId !== '' ? nodeId : instance?.currentStepId ?? '')

  useEffect(() => {
    void select(gateway, instanceId)
  }, [gateway, instanceId, select])

  const definitionId = instance?.definitionId
  const definitionRevision = instance?.definitionRevision
  useEffect(() => {
    if (definitionId !== undefined && definitionRevision !== undefined) {
      void loadDefinition(gateway, definitionId, definitionRevision)
    }
  }, [gateway, definitionId, definitionRevision, loadDefinition])

  const poll = useCallback(
    async (signal: AbortSignal) => {
      if (signal.aborted) return
      await useAgentWorkflowsStore.getState().refreshInstance(gateway, { silent: true, signal })
    },
    [gateway],
  )
  const { degraded } = useSilentPolling(poll, { intervalMs: 3_000, enabled: status === 'ready' && selectInstancePolling(instance) })

  const recoverySchemaJson = useMemo(() => {
    if (instance === undefined) return undefined
    const recoveryNode = tree?.nodes.find((item) => item.id === selectedRecoveryNodeId)
    if (recoveryNode !== undefined && tree !== undefined) {
      const scope = tree.scopes.find((item) => item.id === recoveryNode.scopeId)
      return scope?.body.steps.find((step) => step.id === recoveryNode.stepId)?.outputSchemaJson
    }
    if (instance.languageVersion !== 'workflow/v2') {
      return definition?.steps.find((step) => step.id === instance.currentStepId)?.outputSchemaJson
    }
    const node = tree?.nodes.find((item) => item.id === instance.currentStepId)
    const scope = node !== undefined && tree !== undefined ? tree.scopes.find((item) => item.id === node.scopeId) : undefined
    return scope?.body.steps.find((step) => step.id === node?.stepId)?.outputSchemaJson
  }, [definition, instance, selectedRecoveryNodeId, tree])

  const backToList = () => navigate('/agent/workflows?view=instances')

  const confirmCancel = async () => {
    await inFlightOnly(async () => {
      try {
        const result = await cancel(gateway, instanceId)
        notify({
          tone: 'info',
          message:
            result.status === 'cancelled'
              ? '取消已完成：实例与未终态步骤均已取消'
              : '取消请求已提交：等待运行中的执行确认停止，实例暂未进入终态',
        })
        setCancelOpen(false)
      } catch (error) {
        notify({ tone: 'danger', message: error instanceof Error ? error.message : '取消工作流实例失败' })
      }
    })
  }

  if (status === 'loading' || status === 'idle') return <LoadingState label="正在读取实例详情…" />
  if (status === 'error') {
    return <ErrorState description={errorMessage} onRetry={() => void select(gateway, instanceId)} action={
      <button type="button" className={CTL_SECONDARY} onClick={backToList}>返回实例列表</button>
    } />
  }
  if (instance === undefined) return null

  const terminal = !selectInstancePolling(instance)
  const usageRows = workflowUsageRows(instance)

  return (
    <div className="flex flex-col gap-4">
      <div className="relative panel-surface">
        <BusyVeil busy={reloading} />
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold">实例 {instance.id}</h2>
              <AgentWorkflowStatusTag status={instance.status} />
              {instance.cancelRequestedAt !== undefined && instance.status !== 'cancelled' ? (
                <span className="rounded border border-warning/50 px-1.5 py-0.5 text-xs text-warning">
                  已请求取消（{formatDateTime(instance.cancelRequestedAt)}），等待执行确认停止
                </span>
              ) : null}
              {instance.languageVersion !== undefined ? (
                <span className="rounded border border-line px-1.5 py-0.5 text-xs text-fg-muted">{instance.languageVersion}</span>
              ) : null}
            </div>
            <p className="text-xs text-fg-muted">
              模板 {instance.definitionId}（修订 {instance.definitionRevision}）· 来源会话 {instance.sourceSessionId}（复制其模型修订与能力环境快照）·
              专属会话 {instance.sessionId} · Task {instance.taskId} · 模型 {instance.model.name}
            </p>
            <p className="text-xs tabular-nums text-fg-subtle">
              状态修订 {instance.revision} · lastSeq {instance.lastSeq} · 创建 {formatDateTime(instance.createdAt)} · 更新 {formatDateTime(instance.updatedAt)}
              {instance.endedAt !== undefined ? ` · 结束 ${formatDateTime(instance.endedAt)}` : ''}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <RefreshButton onPress={() => void refresh(gateway)} busy={reloading} formControl />
            {instance.allowedActions.length > 0 ? (
              <button type="button" className={CTL_PRIMARY} onClick={() => { setRecoveryNodeId(undefined); setRecoveryOpen(true) }}>
                人工恢复（{instance.allowedActions.length} 个可用动作）
              </button>
            ) : null}
            {!terminal ? (
              <button type="button" className={CTL_DANGER} onClick={() => setCancelOpen(true)} disabled={cancelling || instance.cancelRequestedAt !== undefined}
                title={instance.cancelRequestedAt !== undefined ? '取消请求已提交，等待执行确认停止' : undefined}>
                {instance.cancelRequestedAt !== undefined ? '取消请求已提交' : '取消实例'}
              </button>
            ) : null}
            <button type="button" className={CTL_SECONDARY} onClick={backToList}>
              <CornerDownRight aria-hidden size={13} />
              返回列表
            </button>
          </div>
        </div>
        {instance.error !== undefined ? (
          <div className="flex items-start gap-2 border-b border-line bg-danger/5 px-4 py-2.5" role="alert">
            <TriangleAlert aria-hidden size={14} className="mt-0.5 shrink-0 text-danger" />
            <p className="text-xs text-danger">
              {instance.error.message}（code：{instance.error.code}）
              {instance.status === 'recovery-required' ? '；等待人工恢复，恢复动作按服务端 allowedActions 展示' : ''}
            </p>
          </div>
        ) : null}
        <div className="grid gap-4 p-4 lg:grid-cols-2">
          <div className="flex flex-col gap-3">
            <h3 className="text-xs font-medium text-fg-muted">输入与输出（服务端原文）</h3>
            <JsonView text={instance.inputJson} label="实例输入（inputJson）" />
            {instance.outputJson !== undefined ? <JsonView text={instance.outputJson} label="最终输出（outputJson）" /> : null}
          </div>
          <div className="flex flex-col gap-3">
            <h3 className="text-xs font-medium text-fg-muted">预算用量（limits vs usage，恢复不重置预算）</h3>
            <ul className="flex flex-col gap-2">
              {usageRows.map((row) => (
                <li key={row.key} className="flex flex-col gap-1">
                  <div className="flex items-baseline justify-between gap-2 text-xs">
                    <span className="text-fg-muted">{row.label}</span>
                    <span className="tabular-nums text-fg-subtle">{row.usedText} / {row.limitText}</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded bg-surface-raised" aria-hidden>
                    <div
                      className={`h-full rounded ${row.ratio >= 1 ? 'bg-danger' : row.ratio >= 0.8 ? 'bg-warning' : 'bg-fg-subtle'}`}
                      style={{ width: `${Math.round(row.ratio * 100)}%` }}
                    />
                  </div>
                </li>
              ))}
              <li className="text-xs text-fg-subtle">每步尝试上限 {instance.limits.attempts} 次；实例累计预算耗尽后不允许恢复。</li>
            </ul>
          </div>
        </div>
        <div className="border-t border-line px-4 py-3">
          <JsonView text={JSON.stringify(instance.snapshot, null, 2)} label="固定能力环境快照" collapseBytes={2048} />
        </div>
      </div>

      {degraded ? (
        <p role="status" className="text-xs text-warning">
          连接中断，正在重试
        </p>
      ) : null}

      <ExecutionTreeView
        instance={instance}
        tree={tree}
        definition={definition}
        highlightedNodeId={nodeId}
        onRecover={(node) => { setRecoveryNodeId(node.id); setRecoveryOpen(true) }}
      />
      <WorkflowRecordsView />

      {recoveryOpen ? (
        <RecoveryDialog
          instance={instance}
          nodes={tree?.nodes ?? []}
          defaultNodeId={selectedRecoveryNodeId}
          outputSchemaJson={recoverySchemaJson}
          onClose={() => { setRecoveryOpen(false); setRecoveryNodeId(undefined) }}
          onRecovered={() => {
            notify({ tone: 'success', message: '恢复动作已提交：预算用量保持连续，节点将重新推进' })
            setRecoveryOpen(false)
            setRecoveryNodeId(undefined)
          }}
        />
      ) : null}

      {cancelOpen ? (
        <Dialog.Root open onOpenChange={(next) => !next && setCancelOpen(false)}>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay" />
            <Dialog.Content aria-describedby={undefined}
              className="fixed left-1/2 top-1/2 z-[61] w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 panel-surface p-4 shadow-xl">
              <Dialog.Title className="text-sm font-semibold">确认取消实例 {instance.id}</Dialog.Title>
              <p className="mt-2 text-xs text-fg-muted">
                取消请求会撤销该实例全部待审批项并停止派发。「取消请求已提交」不等于「已停止」：运行中的执行
                需要确认停止后实例才进入已取消终态；已成功的步骤不回滚。
              </p>
              <div className="mt-4 flex justify-end gap-2">
                <button type="button" className={CTL_SECONDARY} onClick={() => setCancelOpen(false)} disabled={cancelling}>再想想</button>
                <button type="button" className={CTL_DANGER} onClick={() => void confirmCancel()} disabled={cancelling}>
                  {cancelling ? '提交中…' : '确认取消实例'}
                </button>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      ) : null}
    </div>
  )
}

/** 深链：屏障治理入口（/agent/approvals?tab=barriers）。 */
export function WorkflowBarrierDeepLink() {
  return (
    <Link to="/agent/approvals?tab=barriers" className="text-xs text-info underline underline-offset-2">
      前往治理中心核实未决执行屏障
    </Link>
  )
}
