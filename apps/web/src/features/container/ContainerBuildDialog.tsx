import * as Dialog from '@radix-ui/react-dialog'
import type { ContainerApp, ContainerBuildSubmitInput } from '@elysian/contracts'
import { Button } from '../../components/Button'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { CTL_PRIMARY, CTL_SECONDARY } from '../../components/formControl'
import { Hammer, TriangleAlert, X } from '../../components/icons'
import { LoadingOrb } from '../../components/LoadingOrb'
import { isDockerRuntime } from '../../utils/isDockerRuntime'
import { ContainerBuildFields } from './ContainerBuildFields'
import { formatWorkspaceSize } from './formatWorkspaceSize'
import { useContainerBuildForm } from './useContainerBuildForm'

/** 确认弹窗里的固定提示句：逐字来自 ADR-0021 的爆炸半径声明。 */
const ENGINE_RUN_NOTICE =
  '构建将在 Docker 引擎上执行,Dockerfile 中的指令由引擎运行(限额 2 CPU、2 GiB 内存、单镜像 20 分钟)'

/** 上下文快照语义：ADR-0021 明文要求写进确认弹窗——构建期间改文件不影响进行中的任务。 */
const CONTEXT_SNAPSHOT_NOTICE =
  '上下文为任务开始时的一次性快照：构建期间对工作区文件的改动，下一次构建才会生效。'

/**
 * 构建镜像弹窗：先预览（只读不构建），再二次确认提交。
 * 预览把上下文统计、目标仓库与警告摆在明处；超限上下文在确认前即被禁用。
 */
export function ContainerBuildDialog({ app, onClose }: { app: ContainerApp; onClose: () => void }) {
  const docker = isDockerRuntime()
  const {
    plan, selectedServices, overLimit, canStart, previewing, confirmOpen, submitting, previewDisabled,
    openConfirmation, closeConfirmation, runPreview, submitInput, confirmSubmit, requestClose, fields,
  } = useContainerBuildForm(app, onClose)

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) requestClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay" />
        <Dialog.Content
          aria-describedby="build-dialog-description"
          className="fixed left-1/2 top-1/2 z-[61] flex max-h-[calc(100vh-2rem)] w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col panel-surface p-4 shadow-xl"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <Dialog.Title className="flex items-center gap-1.5 text-sm font-medium">
                <Hammer aria-hidden size={14} />
                构建镜像 · <span className="font-mono">{app.slug}</span>
              </Dialog.Title>
              <p id="build-dialog-description" className="mt-1.5 text-xs text-fg-muted">
                先预览构建内容，再确认提交。产物镜像统一落在 elysian/ 命名空间，不覆盖已有镜像。
              </p>
            </div>
            <Button variant="ghost" size="icon"
              type="button"
              onClick={requestClose}
              aria-label="关闭构建弹窗"
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg"
            >
              <X aria-hidden size={15} />
            </Button>
          </div>

          {!docker ? (
            <p className="mt-2 flex items-center gap-1.5 rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-xs text-warning">
              <TriangleAlert aria-hidden size={13} className="shrink-0" />
              演示模式：构建为内存模拟,不执行真实 Docker 构建。
            </p>
          ) : null}

          <ContainerBuildFields slug={app.slug} {...fields} />

          <div className="mt-4 flex items-center justify-between gap-3 border-t border-line pt-3">
            <p className="min-w-0 flex-1 text-xs text-fg-subtle">
              {overLimit ? '构建上下文超过上限,任务将在打包阶段失败,请先精简上下文。' : '预览只读不构建；提交前还会再确认一次。'}
            </p>
            <div className="flex shrink-0 gap-2">
              <Button variant="outline" type="button" onClick={requestClose} className={`${CTL_SECONDARY} px-3`}>
                取消
              </Button>
              <Button variant="primary"
                type="button"
                onClick={runPreview}
                disabled={previewDisabled}
                className={`${CTL_PRIMARY} gap-1.5 px-3`}
              >
                {previewing ? <LoadingOrb size={13} /> : null}
                {previewing ? '预览中…' : '预览构建'}
              </Button>
              <Button variant="primary"
                type="button"
                onClick={openConfirmation}
                disabled={!canStart || submitting}
                className={`${CTL_PRIMARY} px-3`}
              >
                开始构建
              </Button>
            </div>
          </div>
        </Dialog.Content>

        {confirmOpen && plan ? (
          <ConfirmBuildDialog
            app={app}
            input={submitInput()}
            notice={ENGINE_RUN_NOTICE}
            submitting={submitting}
            onCancel={closeConfirmation}
            onConfirm={confirmSubmit}
            contextLines={
              plan.mode === 'dockerfile'
                ? [
                    {
                      label: 'Dockerfile',
                      value: plan.dockerfile,
                      detail: `上下文 ${plan.context}（${plan.contextFiles} 个文件、${formatWorkspaceSize(plan.contextBytes)}）`,
                    },
                    { label: '目标镜像仓库', value: plan.imageRepository, detail: '' },
                  ]
                : [
                    ...plan.services
                      .filter((service) => selectedServices.includes(service.service))
                      .map((service) => ({
                        label: `服务 ${service.service}`,
                        value: service.imageRepository,
                        detail: `Dockerfile ${service.dockerfile}，上下文 ${service.context}（${service.contextFiles} 个文件、${formatWorkspaceSize(service.contextBytes)}）`,
                      })),
                  ]
            }
          />
        ) : null}
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** 二次确认弹窗：逐字列出工作区、模式、路径、上下文统计与目标仓库，确认后才提交。 */
function ConfirmBuildDialog({
  app,
  input,
  contextLines,
  notice,
  submitting,
  onCancel,
  onConfirm,
}: {
  app: ContainerApp
  input: ContainerBuildSubmitInput
  contextLines: readonly { label: string; value: string; detail: string }[]
  notice: string
  submitting: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <ConfirmDialog
      title="确认开始构建？"
      surface={{
        layer: 'nested', preventOutsideDismiss: true,
        'aria-describedby': 'confirm-build-description',
        className: 'w-[min(30rem,calc(100vw-2rem))] p-4 shadow-xl',
      }}
      busy={submitting}
      confirmLabel={submitting ? <><LoadingOrb size={13} />提交中…</> : '确认并开始构建'}
      cancelClassName="px-3" confirmClassName="gap-1.5 px-3"
      onClose={onCancel} onConfirm={onConfirm}
    >
      <div id="confirm-build-description" className="mt-2 space-y-1 text-xs">
        <p>
          工作区：<span className="font-mono">{app.slug}</span>
        </p>
        <p>模式：{input.mode === 'dockerfile' ? 'Dockerfile 构建' : 'compose 服务构建'}</p>
        {input.mode === 'compose' ? (
          <p>
            compose 文件：<span className="font-mono">{input.compose}</span>
          </p>
        ) : null}
        <ul className="space-y-1">
          {contextLines.map((line) => (
            <li key={line.label}>
              <p className="break-all">
                {line.label}：<span className="font-mono">{line.value}</span>
              </p>
              {line.detail ? <p className="break-all text-fg-subtle">{line.detail}</p> : null}
            </li>
          ))}
        </ul>
        <p className="rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-warning">{notice}</p>
        <p className="text-fg-subtle">{CONTEXT_SNAPSHOT_NOTICE}</p>
        <p className="text-fg-subtle">构建为异步任务，提交后可在「构建任务」区查看进度与日志。</p>
      </div>
    </ConfirmDialog>
  )
}
