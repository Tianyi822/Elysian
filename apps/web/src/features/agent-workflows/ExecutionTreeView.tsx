import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import type {
  AgentWorkflowDefinition,
  AgentWorkflowExecutionTree,
  AgentWorkflowInstance,
  AgentWorkflowNodeExecution,
  AgentWorkflowScope,
  AgentWorkflowStatus,
} from '@elysian/contracts'
import { AgentWorkflowStatusTag } from '../../components/agent/AgentStatusTag'
import { JsonView } from '../../components/agent/JsonView'
import { EmptyState } from '../../components/states/StateViews'
import { StatusTag } from '../../components/StatusTag'
import type { StatusTone } from '../../components/StatusTag'
import { CTL_CARD_ACTION } from '../../components/formControl'
import { ChevronDown, ChevronRight, Split } from '../../components/icons'
import { useAgentWorkflowsStore } from '../../stores/agentWorkflowsStore'
import {
  WORKFLOW_JOIN_NAMESPACE_NOTE,
  WORKFLOW_SIBLING_FREEZE_NOTE,
  attemptLimitText,
  childScopeGroups,
  scopeNodeRows,
  workflowStepKindLabel,
} from './workflowFormat'

/**
 * 执行树：workflow/v2 按 RootScopeID/parentScopeId 递归渲染 Scope 分组的折叠树，
 * parallel 分支与 foreach 项按序号展开；nodeId 深链定位高亮并滚动聚焦。
 * v1 实例渲染单链步骤列表（执行树端点对 v1 恒为空 scopes/nodes）。
 */
export function ExecutionTreeView({
  instance,
  tree,
  definition,
  highlightedNodeId,
  onRecover,
}: {
  instance: AgentWorkflowInstance
  tree?: AgentWorkflowExecutionTree
  definition?: AgentWorkflowDefinition
  highlightedNodeId: string
  onRecover(node: AgentWorkflowNodeExecution): void
}) {
  const isV2 = instance.languageVersion === 'workflow/v2'
  return (
    <section aria-label="执行树" className="relative panel-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div className="flex items-center gap-2">
          <Split aria-hidden size={15} className="text-fg-subtle" />
          <h2 className="text-sm font-semibold">执行树</h2>
          <span className="text-xs text-fg-subtle">{isV2 ? 'workflow/v2 · Scope 分组' : 'v1 · 单链步骤'}</span>
        </div>
      </div>
      <div className="flex flex-col gap-3 p-4">
        {isV2 ? (
          tree === undefined || tree.scopes.length === 0 ? (
            <EmptyState title="暂无执行树" description="workflow/v2 实例创建后即建立根作用域；当前没有可呈现的作用域。" />
          ) : (
            (() => {
              const rootScope = tree.scopes.find((item) => item.id === tree.rootScopeId) ?? tree.scopes[0]
              return rootScope === undefined ? null : (
                <ScopeBlock scope={rootScope} tree={tree} instance={instance} depth={0} highlightedNodeId={highlightedNodeId} onRecover={onRecover} />
              )
            })()
          )
        ) : definition === undefined ? (
          <EmptyState title="模板详情尚未就绪" description="v1 单链视图依赖模板步骤定义，正在读取。" />
        ) : (
          <V1ChainView instance={instance} definition={definition} />
        )}
        <div className="flex flex-col gap-1 rounded-lg border border-dashed border-line p-3">
          <p className="text-xs text-fg-subtle">{WORKFLOW_SIBLING_FREEZE_NOTE}</p>
          {isV2 ? <p className="text-xs text-fg-subtle">{WORKFLOW_JOIN_NAMESPACE_NOTE}</p> : null}
          <p className="text-xs text-fg-subtle">parallel join 的输出是按分支 id 的键控对象；foreach 的输出是按项序号的数组。</p>
        </div>
      </div>
    </section>
  )
}

/**
 * 节点/作用域状态标签：'skipped' 是服务端对不可达节点的落库值（scope_runtime.go:680），
 * 冻结契约的中文标签表暂缺——本地兜底「已跳过」，文字+颜色双表达。
 */
export function WorkflowNodeStatusTag({ status }: { status: AgentWorkflowStatus | 'skipped' }) {
  if (status === 'skipped') {
    return <StatusTag label="已跳过" tone={'neutral' as StatusTone} />
  }
  return <AgentWorkflowStatusTag status={status} />
}

function ScopeBlock({
  scope,
  tree,
  instance,
  depth,
  highlightedNodeId,
  onRecover,
}: {
  scope: AgentWorkflowScope
  tree: AgentWorkflowExecutionTree
  instance: AgentWorkflowInstance
  depth: number
  highlightedNodeId: string
  onRecover(node: AgentWorkflowNodeExecution): void
}) {
  const [open, setOpen] = useState(true)
  const rows = scopeNodeRows(scope, tree.nodes)
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3" style={{ marginLeft: depth * 14 }}>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex items-center gap-1 rounded px-1 py-0.5 text-xs font-medium text-fg transition-colors hover:text-fg-muted"
        >
          {open ? <ChevronDown aria-hidden size={13} /> : <ChevronRight aria-hidden size={13} />}
          作用域 {scope.kind}
        </button>
        <span className="font-mono text-xs text-fg-subtle">{scope.path}</span>
        <span className="text-xs tabular-nums text-fg-subtle">depth {scope.depth} · ordinal {scope.ordinal}</span>
        <AgentWorkflowStatusTag status={scope.status} />
        <span className="text-xs text-fg-subtle">私有 Task <span className="font-mono">{scope.taskId}</span></span>
      </div>
      {open ? (
        <div className="flex flex-col gap-2">
          <dl className="grid gap-1 text-xs text-fg-muted sm:grid-cols-2">
            <div><dt className="inline text-fg-subtle">Scope ID </dt><dd className="inline font-mono">{scope.id}</dd></div>
            <div><dt className="inline text-fg-subtle">父作用域 </dt><dd className="inline font-mono">{scope.parentScopeId ?? '根'}</dd></div>
            <div><dt className="inline text-fg-subtle">父工作区修订 </dt><dd className="inline tabular-nums">{scope.parentWorkspaceRevision}</dd></div>
            <div><dt className="inline text-fg-subtle">父工作记忆修订 </dt><dd className="inline tabular-nums">{scope.parentMemoryRevision}</dd></div>
          </dl>
          {rows.map((row) => (
            <div key={row.node.id} className="flex flex-col gap-2">
              <NodeRow node={row.node} instance={instance} highlightedNodeId={highlightedNodeId} onRecover={onRecover} />
              {row.node.expanded ? (
                <div className="flex flex-col gap-2">
                  {childScopeGroups(row.node.id, tree.scopes).map((child) => (
                    <ScopeBlock key={child.id} scope={child} tree={tree} instance={instance} depth={depth + 1} highlightedNodeId={highlightedNodeId} onRecover={onRecover} />
                  ))}
                </div>
              ) : null}
            </div>
          ))}
          {scope.inputJson !== '' ? <JsonView text={scope.inputJson} label="作用域输入（inputJson）" collapseBytes={512} /> : null}
          {scope.outputJson !== undefined ? <JsonView text={scope.outputJson} label="作用域输出（outputJson）" collapseBytes={512} /> : null}
        </div>
      ) : null}
    </div>
  )
}

function NodeRow({
  node,
  instance,
  highlightedNodeId,
  onRecover,
}: {
  node: AgentWorkflowNodeExecution
  instance: AgentWorkflowInstance
  highlightedNodeId: string
  onRecover(node: AgentWorkflowNodeExecution): void
}) {
  const highlighted = highlightedNodeId === node.id
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ block: 'center' })
  }, [highlighted])
  return (
    <div
      ref={ref}
      id={`workflow-node-${node.id}`}
      tabIndex={-1}
      className={`flex flex-col gap-1.5 rounded-lg border bg-surface p-2.5 transition-shadow ${
        highlighted ? 'border-focus ring-2 ring-focus/60' : 'border-line'
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <WorkflowNodeStatusTag status={node.status} />
        <span className="rounded border border-line px-1.5 py-0.5 text-xs text-fg-muted">{workflowStepKindLabel(node.kind)}</span>
        <span className="font-mono text-xs font-medium text-fg">{node.stepId}</span>
        <span className="font-mono text-xs text-fg-subtle">{node.stableKey}</span>
        <span className="text-xs tabular-nums text-fg-subtle">attempt {attemptLimitText(node, instance.limits)}</span>
        {node.runId !== undefined ? <Link className="font-mono text-xs text-fg-subtle underline-offset-2 hover:underline" to={`/agent/runs?runId=${encodeURIComponent(node.runId)}`}>run {node.runId}</Link> : null}
        {node.expanded ? <span className="rounded border border-line px-1.5 py-0.5 text-xs text-fg-muted">已展开（分支子作用域见下）</span> : null}
      </div>
      {node.error !== undefined ? (
        <p className="text-xs text-danger">{node.error.message}（code：{node.error.code}）</p>
      ) : null}
      {node.inputJson !== '' ? <JsonView text={node.inputJson} label="节点输入（inputJson）" collapseBytes={512} /> : null}
      {node.outputJson !== undefined ? <JsonView text={node.outputJson} label="节点输出（outputJson）" collapseBytes={512} /> : null}
      <div className="flex flex-wrap items-center gap-2">
        {node.allowedActions.length > 0 ? (
          <>
            <span className="text-xs text-fg-subtle">可用恢复动作：{node.allowedActions.join(' / ')}</span>
            <button type="button" className={CTL_CARD_ACTION} onClick={() => onRecover(node)}>
              恢复此节点
            </button>
          </>
        ) : null}
      </div>
    </div>
  )
}

/** v1 单链步骤列表：状态取该步骤最新一次尝试；attempt 展示该步骤累计次数。 */
function V1ChainView({ instance, definition }: { instance: AgentWorkflowInstance; definition: AgentWorkflowDefinition }) {
  const attempts = useAgentWorkflowsStore((state) => state.attempts.items)
  return (
    <ol className="flex flex-col gap-2">
      {definition.steps.map((step) => {
        const latest = [...attempts].reverse().find((attempt) => attempt.stepId === step.id)
        const count = attempts.filter((attempt) => attempt.stepId === step.id).length
        const isCurrent = instance.currentStepId === step.id
        return (
          <li key={step.id} className={`flex flex-col gap-1 rounded-lg border bg-surface p-2.5 ${isCurrent ? 'border-focus ring-2 ring-focus/60' : 'border-line'}`}>
            <div className="flex flex-wrap items-center gap-2">
              {latest === undefined ? (
                <span className="rounded border border-line px-1.5 py-0.5 text-xs text-fg-subtle">未开始</span>
              ) : (
                <AgentWorkflowStatusTag status={latest.status} />
              )}
              <span className="rounded border border-line px-1.5 py-0.5 text-xs text-fg-muted">{workflowStepKindLabel(step.kind)}</span>
              <span className="font-mono text-xs font-medium text-fg">{step.id}</span>
              <span className="text-xs tabular-nums text-fg-subtle">尝试 {count} / {instance.limits.attempts}</span>
              {isCurrent ? <span className="rounded border border-focus px-1.5 py-0.5 text-xs text-fg">当前步骤</span> : null}
              {latest?.runId !== undefined ? <Link className="font-mono text-xs text-fg-subtle underline-offset-2 hover:underline" to={`/agent/runs?runId=${encodeURIComponent(latest.runId)}`}>run {latest.runId}</Link> : null}
            </div>
            {latest?.inputJson !== undefined && latest.inputJson !== '' ? <JsonView text={latest.inputJson} label="尝试输入（inputJson）" collapseBytes={512} /> : null}
            {latest?.outputJson !== undefined ? <JsonView text={latest.outputJson} label="尝试输出（outputJson）" collapseBytes={512} /> : null}
            {latest?.evidence !== undefined ? <p className="text-xs text-fg-muted">核实说明：{latest.evidence}</p> : null}
          </li>
        )
      })}
    </ol>
  )
}
