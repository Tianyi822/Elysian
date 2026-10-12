import { useEffect, useState } from 'react'
import type { AgentWorkflowDefinition, AgentWorkflowStepDefinition } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { isDockerRuntime } from '../../app/runtime/isDockerRuntime'
import { JsonView } from '../../components/agent/JsonView'
import { BusyVeil, RefreshButton } from '../../components/RefreshState'
import { EmptyState, ErrorState, LoadingState } from '../../components/states/StateViews'
import { CTL_PRIMARY, CTL_SECONDARY } from '../../components/formControl'
import { formatDateTime } from '../../components/format'
import { GitBranch, Plus } from '../../components/icons'
import { useNotificationStore } from '../../stores/notificationStore'
import { useAgentWorkflowsStore } from '../../stores/agentWorkflowsStore'
import { CreateInstanceDialog } from './CreateInstanceDialog'
import { DefinitionEditorDialog } from './DefinitionEditorDialog'
import { describeWorkflowBinding, workflowStepKindLabel } from './workflowFormat'

/** 模板视图：列表 + 详情（inputSchemaJson/outputSchemaJson 与步骤树）。 */
export function DefinitionsSection() {
  const gateway = useGateway()
  const notify = useNotificationStore((state) => state.notify)
  const status = useAgentWorkflowsStore((state) => state.definitions.status)
  const items = useAgentWorkflowsStore((state) => state.definitions.items)
  const errorMessage = useAgentWorkflowsStore((state) => state.definitions.errorMessage)
  const reloading = useAgentWorkflowsStore((state) => state.definitions.reloading)
  const load = useAgentWorkflowsStore((state) => state.loadDefinitions)
  const detailStatus = useAgentWorkflowsStore((state) => state.definitionDetail.status)
  const detail = useAgentWorkflowsStore((state) => state.definitionDetail.definition)
  const detailError = useAgentWorkflowsStore((state) => state.definitionDetail.errorMessage)
  const loadDetail = useAgentWorkflowsStore((state) => state.loadDefinitionDetail)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [createFor, setCreateFor] = useState<AgentWorkflowDefinition | null>(null)

  useEffect(() => {
    void load(gateway)
  }, [gateway, load])

  useEffect(() => {
    if (selectedId !== null) void loadDetail(gateway, selectedId)
  }, [gateway, loadDetail, selectedId])

  const demo = !isDockerRuntime()

  return (
    <div className="flex flex-col gap-4">
      <div className="relative overflow-x-auto panel-surface">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div className="flex items-center gap-2">
            <GitBranch aria-hidden size={15} className="text-fg-subtle" />
            <h2 className="text-sm font-semibold">工作流模板</h2>
            {demo ? <span className="text-xs text-fg-subtle">（演示数据）</span> : null}
          </div>
          <div className="flex items-center gap-2">
            <RefreshButton onPress={() => void load(gateway)} busy={reloading} formControl />
            <button type="button" className={CTL_PRIMARY} onClick={() => setEditorOpen(true)}>
              <Plus aria-hidden size={13} />
              新建模板
            </button>
          </div>
        </div>
        <BusyVeil busy={reloading} />
        {status === 'loading' || status === 'idle' ? <div className="p-4"><LoadingState /></div> : null}
        {status === 'error' ? (
          <div className="p-4">
            <ErrorState description={errorMessage} onRetry={() => void load(gateway)} />
          </div>
        ) : null}
        {status === 'ready' && items.length === 0 ? (
          <div className="p-4">
            <EmptyState title="暂无工作流模板" description="新建模板后即可从模板创建实例；模板按不可变修订演进。" action={
              <button type="button" className={`${CTL_SECONDARY} mt-1 px-2`} onClick={() => setEditorOpen(true)}>新建模板</button>
            } />
          </div>
        ) : null}
        {status === 'ready' && items.length > 0 ? (
          <table className="w-full min-w-[52rem] table-fixed border-separate border-spacing-0 text-left text-sm">
            <colgroup>
              <col className="w-[22%]" />
              <col className="w-[12%]" />
              <col className="w-[8%]" />
              <col className="w-[8%]" />
              <col className="w-[10%]" />
              <col className="w-[40%]" />
            </colgroup>
            <thead>
              <tr>
                {['名称', '语言版本', '修订', '步数', '启用', '目标'].map((label) => (
                  <th key={label} scope="col" className="border-b border-line bg-surface px-3 py-2.5 text-xs font-medium text-fg-muted">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((definition) => (
                <tr
                  key={`${definition.id}-${definition.revision}`}
                  onClick={() => setSelectedId(definition.id)}
                  className={`cursor-pointer transition-colors hover:bg-surface-raised ${selectedId === definition.id ? 'bg-surface-raised' : ''}`}
                >
                  <td className="border-b border-line px-3 py-2.5 font-medium text-fg">{definition.name}</td>
                  <td className="border-b border-line px-3 py-2.5 tabular-nums text-fg-muted">
                    <span className="rounded border border-line px-1.5 py-0.5 text-xs">{definition.languageVersion ?? 'v1'}</span>
                  </td>
                  <td className="border-b border-line px-3 py-2.5 tabular-nums text-fg-muted">{definition.revision}</td>
                  <td className="border-b border-line px-3 py-2.5 tabular-nums text-fg-muted">{definition.steps.length}</td>
                  <td className="border-b border-line px-3 py-2.5 text-fg-muted">{definition.enabled ? '已启用' : '已停用'}</td>
                  <td className="border-b border-line px-3 py-2.5 text-fg-muted"><span className="line-clamp-2">{definition.goal}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>

      {selectedId !== null ? (
        detailStatus === 'loading' || detailStatus === 'idle' ? (
          <LoadingState label="正在读取模板详情…" />
        ) : detailStatus === 'error' ? (
          <ErrorState description={detailError} onRetry={() => void loadDetail(gateway, selectedId)} />
        ) : detail !== undefined ? (
          <div className="relative panel-surface">
            <DefinitionDetailView
              definition={detail}
              onClose={() => setSelectedId(null)}
              onUpdate={() => setEditorOpen(true)}
              onCreate={() => setCreateFor(detail)}
            />
          </div>
        ) : null
      ) : null}

      {editorOpen ? (
        <DefinitionEditorDialog
          definition={selectedId !== null ? detail : undefined}
          onClose={() => setEditorOpen(false)}
          onSaved={(definition) => {
            notify({ tone: 'success', message: `模板 ${definition.name} 已保存为修订 ${definition.revision}` })
            setEditorOpen(false)
            setSelectedId(definition.id)
          }}
        />
      ) : null}
      {createFor !== null ? (
        <CreateInstanceDialog
          definition={createFor}
          onClose={() => setCreateFor(null)}
          onCreated={() => {
            notify({ tone: 'success', message: '工作流实例已提交创建，正在轮询推进状态' })
            setCreateFor(null)
          }}
        />
      ) : null}
    </div>
  )
}

/** 模板详情：字段、Schema 原文与步骤树（绑定五选一标注）。 */
export function DefinitionDetailView({
  definition,
  onClose,
  onUpdate,
  onCreate,
}: {
  definition: AgentWorkflowDefinition
  onClose(): void
  onUpdate(): void
  onCreate(): void
}) {
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{definition.name}（修订 {definition.revision}）</h3>
          <p className="mt-1 text-xs text-fg-muted">
            {definition.languageVersion ?? 'v1'} · {definition.enabled ? '已启用' : '已停用'} · 入口 {definition.entry} · 创建于 {formatDateTime(definition.createdAt)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className={CTL_SECONDARY} onClick={onUpdate}>更新模板</button>
          <button type="button" className={CTL_PRIMARY} onClick={onCreate} disabled={!definition.enabled} title={definition.enabled ? undefined : '模板已停用，不能创建实例'}>
            从模板创建实例
          </button>
          <button type="button" className={CTL_SECONDARY} onClick={onClose}>返回列表</button>
        </div>
      </div>
      <p className="text-xs text-fg-muted">{definition.goal}</p>
      <div className="grid gap-3 md:grid-cols-2">
        <JsonView text={definition.inputSchemaJson} label="输入 Schema（inputSchemaJson）" />
        <JsonView text={definition.outputSchemaJson} label="最终输出 Schema（outputSchemaJson）" />
      </div>
      <div>
        <h4 className="mb-2 text-xs font-medium text-fg-muted">步骤树（绑定按五选一标注，原文不重排）</h4>
        <ol className="flex flex-col gap-2">
          {definition.steps.map((step) => (
            <StepDefinitionRow key={step.id} step={step} depth={0} />
          ))}
        </ol>
      </div>
    </div>
  )
}

/** 递归渲染步骤定义；parallel/foreach 的分支主体缩进呈现。 */
function StepDefinitionRow({ step, depth }: { step: AgentWorkflowStepDefinition; depth: number }) {
  const children: (readonly AgentWorkflowStepDefinition[])[] = []
  if (step.parallel !== undefined) children.push(...step.parallel.branches.map((branch) => branch.body.steps))
  if (step.foreach !== undefined) children.push(step.foreach.body.steps)
  return (
    <li className="rounded-lg border border-line bg-surface p-3" style={{ marginLeft: depth * 16 }}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="rounded border border-line px-1.5 py-0.5 text-xs text-fg-muted">{workflowStepKindLabel(step.kind)}</span>
        <span className="font-mono text-xs font-medium text-fg">{step.id}</span>
        {step.instruction !== undefined ? <span className="text-xs text-fg-muted">{step.instruction}</span> : null}
      </div>
      <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs md:grid-cols-2">
        <div className="flex gap-2">
          <dt className="shrink-0 text-fg-subtle">输入绑定</dt>
          <dd className="min-w-0 break-all text-fg-muted">{describeWorkflowBinding(step.input)}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="shrink-0 text-fg-subtle">输出 Schema</dt>
          <dd className="min-w-0 break-all font-mono text-fg-muted">{step.outputSchemaJson}</dd>
        </div>
        {step.next !== undefined ? (
          <div className="flex gap-2">
            <dt className="shrink-0 text-fg-subtle">下一步</dt>
            <dd className="font-mono text-fg-muted">{step.next}</dd>
          </div>
        ) : null}
        {step.then !== undefined && step.else !== undefined ? (
          <div className="flex gap-2">
            <dt className="shrink-0 text-fg-subtle">条件分支</dt>
            <dd className="font-mono text-fg-muted">是 → {step.then} · 否 → {step.else}</dd>
          </div>
        ) : null}
        {step.finish !== undefined ? (
          <div className="flex gap-2">
            <dt className="shrink-0 text-fg-subtle">最终输出绑定</dt>
            <dd className="min-w-0 break-all text-fg-muted">{describeWorkflowBinding(step.finish)}</dd>
          </div>
        ) : null}
        {step.capability !== undefined ? (
          <div className="flex gap-2">
            <dt className="shrink-0 text-fg-subtle">能力别名</dt>
            <dd className="font-mono text-fg-muted">{step.capability}</dd>
          </div>
        ) : null}
      </dl>
      {children.length > 0 ? (
        <div className="mt-3 flex flex-col gap-2">
          {children.map((steps, index) => (
            <div key={index} className="rounded-lg border border-dashed border-line p-2">
              <p className="mb-1 text-xs text-fg-subtle">
                {step.parallel !== undefined ? `parallel 分支 ${step.parallel.branches[index]?.id ?? index}` : `foreach 项主体 ${index}`}
              </p>
              <ol className="flex flex-col gap-2">
                {steps.map((child) => (
                  <StepDefinitionRow key={child.id} step={child} depth={depth + 1} />
                ))}
              </ol>
            </div>
          ))}
        </div>
      ) : null}
    </li>
  )
}
