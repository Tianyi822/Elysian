import * as Dialog from '@radix-ui/react-dialog'
import { useState } from 'react'
import { Hammer, Loader2, TriangleAlert, X } from '../../components/icons'
import type { ContainerApp, ContainerBuildSubmitInput } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { isDockerRuntime } from '../../app/runtime/isDockerRuntime'
import { CTL_CHIP, CTL_FIELD, CTL_PRIMARY, CTL_SECONDARY } from '../../components/formControl'
import { SelectDropdown } from '../../components/SelectDropdown'
import { SuggestionInput } from '../../components/SuggestionInput'
import { newBuildRequestId, useContainerAppsStore } from '../../stores/containerAppsStore'
import { isComposeFile } from '../../stores/containerAppsStore'
import { formatWorkspaceSize } from './formatWorkspaceSize'
import { useFeedbackMessage } from '../../components/useFeedbackMessage'

/** 上下文超限的判定句：与契约警告逐字同源，前端据此在确认前禁用开始按钮。 */
const CONTEXT_LIMIT_WARNING = '构建上下文超过上限'

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
  const gateway = useGateway()
  const docker = isDockerRuntime()
  const preview = useContainerAppsStore((s) => s.buildPreview)
  const previewBuild = useContainerAppsStore((s) => s.previewBuild)
  const submitBuild = useContainerAppsStore((s) => s.submitBuild)
  const clearBuildPreview = useContainerAppsStore((s) => s.clearBuildPreview)

  const textPaths = app.files.filter((file) => file.text).map((file) => file.path)
  const defaultDockerfile =
    textPaths.find((path) => path === 'Dockerfile') ??
    textPaths.find((path) => path.split('/').pop() === 'Dockerfile') ?? ''
  const composeFiles = app.files.filter((file) => isComposeFile(file.path)).map((file) => file.path)

  const [mode, setMode] = useState<'dockerfile' | 'compose'>(composeFiles.length > 0 && !defaultDockerfile ? 'compose' : 'dockerfile')
  const [target, setTarget] = useState('app')
  const [dockerfile, setDockerfile] = useState(defaultDockerfile)
  const [context, setContext] = useState('.')
  const [compose, setCompose] = useState(composeFiles[0] ?? '')
  const [selectedServices, setSelectedServices] = useState<readonly string[]>([])
  const [confirmOpen, setConfirmOpen] = useState(false)

  const state = preview?.slug === app.slug ? preview : null
  const plan = state?.plan ?? null
  useFeedbackMessage(state?.submitError)

  const switchMode = (next: 'dockerfile' | 'compose') => {
    if (next === mode) return
    setMode(next)
    setSelectedServices([])
    clearBuildPreview()
  }

  const runPreview = () => {
    if (mode === 'dockerfile') {
      const trimmedTarget = target.trim()
      const trimmedContext = context.trim()
      void previewBuild(gateway, app.slug, {
        mode: 'dockerfile',
        ...(trimmedTarget ? { target: trimmedTarget } : {}),
        dockerfile,
        ...(trimmedContext ? { context: trimmedContext } : {}),
      })
      return
    }
    void previewBuild(gateway, app.slug, { mode: 'compose', compose }).then((result) => {
      if (result?.mode === 'compose') {
        // 默认勾选全部含 build 段的服务；用户可再逐个取消。
        setSelectedServices(result.services.filter((service) => service.hasBuild).map((service) => service.service))
      }
    })
  }

  // 超限上下文在确认前即禁用：打包阶段必失败，不让用户白走一遍确认。
  const limitWarnings =
    plan === null
      ? []
      : plan.mode === 'dockerfile'
        ? plan.warnings.filter((warning) => warning.includes(CONTEXT_LIMIT_WARNING))
        : [
            ...plan.warnings,
            ...plan.services.flatMap((service) => service.warnings),
          ].filter((warning) => warning.includes(CONTEXT_LIMIT_WARNING))
  const overLimit = limitWarnings.length > 0
  const previewReady = plan !== null && !overLimit
  const composeSelectionValid = mode === 'compose' && plan?.mode === 'compose'
    ? selectedServices.some((name) => plan.services.some((service) => service.service === name && service.hasBuild))
    : true
  const canStart = previewReady && (mode === 'dockerfile' || composeSelectionValid)

  const submitInput = (): ContainerBuildSubmitInput => {
    const requestId = newBuildRequestId()
    if (mode === 'dockerfile' && plan?.mode === 'dockerfile') {
      return { mode: 'dockerfile', requestId, target: plan.target, dockerfile: plan.dockerfile, context: plan.context }
    }
    if (plan?.mode === 'compose') {
      return { mode: 'compose', requestId, compose: plan.compose, services: selectedServices }
    }
    // 没有预览结果就点不到确认：这里只为类型收窄，不会发生。
    return { mode: 'dockerfile', requestId, dockerfile, context }
  }

  const confirmSubmit = () => {
    void submitBuild(gateway, app.slug, submitInput()).then((ok) => {
      // 确认弹窗只承担「确认」这一步：成功关整个弹窗，失败退回主表单看错误原文。
      setConfirmOpen(false)
      if (ok) onClose()
    })
  }

  const requestClose = () => {
    clearBuildPreview()
    onClose()
  }

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
            <button
              type="button"
              onClick={requestClose}
              aria-label="关闭构建弹窗"
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg"
            >
              <X aria-hidden size={15} />
            </button>
          </div>

          {!docker ? (
            <p className="mt-2 flex items-center gap-1.5 rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-xs text-warning">
              <TriangleAlert aria-hidden size={13} className="shrink-0" />
              演示模式：构建为内存模拟,不执行真实 Docker 构建。
            </p>
          ) : null}

          <div className="mt-3 min-h-0 flex-1 space-y-3 overflow-y-auto pr-0.5">
            <div role="group" aria-label="构建模式" className="flex flex-wrap gap-1.5">
              <button type="button" aria-pressed={mode === 'dockerfile'} onClick={() => switchMode('dockerfile')} className={CTL_CHIP}>
                Dockerfile 构建
              </button>
              <button type="button" aria-pressed={mode === 'compose'} onClick={() => switchMode('compose')} className={CTL_CHIP}>
                compose 服务构建
              </button>
            </div>

            {mode === 'dockerfile' ? (
              <div className="space-y-3">
                <div>
                  <label htmlFor={`build-target-${app.slug}`} className="mb-1 block text-xs font-medium text-fg-muted">
                    镜像目标名（产物仓库为 <span className="font-mono">elysian/{app.slug}/&lt;目标名&gt;</span>）
                  </label>
                  <input
                    id={`build-target-${app.slug}`}
                    value={target}
                    onChange={(event) => {
                      setTarget(event.target.value)
                      // 输入一变旧预览即失效：canStart 回落 false，提交值只能来自最近一次预览。
                      clearBuildPreview()
                    }}
                    placeholder="app"
                    autoComplete="off"
                    spellCheck={false}
                    className={`${CTL_FIELD} font-mono`}
                  />
                </div>
                <div>
                  <label htmlFor={`build-dockerfile-${app.slug}`} className="mb-1 block text-xs font-medium text-fg-muted">
                    Dockerfile 路径（相对工作区根）
                  </label>
                  <SuggestionInput
                    id={`build-dockerfile-${app.slug}`}
                    ariaLabel="Dockerfile 路径（相对工作区根）"
                    items={textPaths.map(path => ({ value: path, label: path }))}
                    value={dockerfile}
                    onValueChange={(value) => {
                      setDockerfile(value)
                      clearBuildPreview()
                    }}
                    placeholder="Dockerfile"
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono"
                  />
                </div>
                <div>
                  <label htmlFor={`build-context-${app.slug}`} className="mb-1 block text-xs font-medium text-fg-muted">
                    构建上下文（相对工作区根，默认 <span className="font-mono">.</span>）
                  </label>
                  <input
                    id={`build-context-${app.slug}`}
                    value={context}
                    onChange={(event) => {
                      setContext(event.target.value)
                      clearBuildPreview()
                    }}
                    placeholder="."
                    autoComplete="off"
                    spellCheck={false}
                    className={`${CTL_FIELD} font-mono`}
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div>
                  <label htmlFor={`build-compose-${app.slug}`} className="mb-1 block text-xs font-medium text-fg-muted">
                    compose 文件（相对工作区根）
                  </label>
                  <SelectDropdown
                    id={`build-compose-${app.slug}`}
                    ariaLabel="compose 文件（相对工作区根）"
                    value={compose}
                    onSelect={(value) => {
                      setCompose(value)
                      setSelectedServices([])
                      clearBuildPreview()
                    }}
                    fullWidth
                    mono
                    items={composeFiles.map((path) => ({ value: path, label: path }))}
                    fallbackLabel="工作区内没有 compose 文件"
                    emptyLabel="工作区内没有 compose 文件"
                    disabled={composeFiles.length === 0}
                  />
                </div>
                {plan?.mode === 'compose' ? (
                  <fieldset className="space-y-1.5">
                    <legend className="text-xs font-medium text-fg-muted">选择要构建的服务</legend>
                    {plan.services.map((service) => (
                      <label
                        key={service.service}
                        className={`flex items-start gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs ${service.hasBuild ? 'cursor-pointer' : 'cursor-not-allowed opacity-70'}`}
                      >
                        <input
                          type="checkbox"
                          checked={selectedServices.includes(service.service)}
                          disabled={!service.hasBuild}
                          onChange={(event) => {
                            setSelectedServices((current) =>
                              event.target.checked
                                ? [...current, service.service]
                                : current.filter((name) => name !== service.service),
                            )
                          }}
                          className="mt-0.5"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="font-mono">{service.service}</span>
                          {service.hasBuild ? (
                            <span className="mt-0.5 block break-all font-mono text-fg-subtle">
                              {service.imageRepository} · 上下文 {service.context}（{service.contextFiles} 个文件、{formatWorkspaceSize(service.contextBytes)}）
                            </span>
                          ) : (
                            <span className="mt-0.5 block font-mono text-fg-subtle">
                              无 build 段{service.imageNameInCompose ? `，镜像 ${service.imageNameInCompose}` : ''}
                            </span>
                          )}
                          {service.warnings.map((warning) => (
                            <span key={warning} className="mt-0.5 block text-warning">
                              {warning}
                            </span>
                          ))}
                        </span>
                      </label>
                    ))}
                  </fieldset>
                ) : null}
              </div>
            )}

            {state?.error ? (
              <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-xs text-danger">
                {state.error}
              </p>
            ) : null}
            {state?.submitError ? (
              <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-xs text-danger">
                {state.submitError}
              </p>
            ) : null}

            {plan?.mode === 'dockerfile' ? (
              <div className="space-y-1.5 rounded-lg border border-line bg-surface px-2.5 py-2 text-xs">
                <p>
                  上下文 <span className="font-mono">{plan.context}</span>：{plan.contextFiles} 个文件、{formatWorkspaceSize(plan.contextBytes)}
                </p>
                <p className="break-all">
                  目标镜像仓库 <span className="font-mono">{plan.imageRepository}</span>
                </p>
                {plan.repositoryOccupied ? (
                  <p className="text-danger">镜像 {plan.imageRepository} 已被非面板构建的镜像占用,构建将被拒绝。</p>
                ) : null}
                {plan.warnings.map((warning) => (
                  <p key={warning} className={warning.includes(CONTEXT_LIMIT_WARNING) ? 'text-danger' : 'text-warning'}>
                    {warning}
                  </p>
                ))}
              </div>
            ) : null}
            {plan?.mode === 'compose' ? (
              <div className="space-y-1.5 rounded-lg border border-line bg-surface px-2.5 py-2 text-xs">
                {plan.warnings.map((warning) => (
                  <p key={warning} className="text-warning">
                    {warning}
                  </p>
                ))}
              </div>
            ) : null}
          </div>

          <div className="mt-4 flex items-center justify-between gap-3 border-t border-line pt-3">
            <p className="min-w-0 flex-1 text-xs text-fg-subtle">
              {overLimit ? '构建上下文超过上限,任务将在打包阶段失败,请先精简上下文。' : '预览只读不构建；提交前还会再确认一次。'}
            </p>
            <div className="flex shrink-0 gap-2">
              <button type="button" onClick={requestClose} className={`${CTL_SECONDARY} px-3`}>
                取消
              </button>
              <button
                type="button"
                onClick={runPreview}
                disabled={state?.loading === true || (mode === 'dockerfile' ? dockerfile.trim() === '' : compose === '')}
                className={`${CTL_PRIMARY} gap-1.5 px-3`}
              >
                {state?.loading ? <Loader2 aria-hidden size={13} className="animate-spin" /> : null}
                {state?.loading ? '预览中…' : '预览构建'}
              </button>
              <button
                type="button"
                onClick={() => setConfirmOpen(true)}
                disabled={!canStart || state?.submitting === true}
                className={`${CTL_PRIMARY} px-3`}
              >
                开始构建
              </button>
            </div>
          </div>
        </Dialog.Content>

        {confirmOpen && plan ? (
          <ConfirmBuildDialog
            app={app}
            input={submitInput()}
            notice={ENGINE_RUN_NOTICE}
            submitting={state?.submitting === true}
            onCancel={() => setConfirmOpen(false)}
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
    <Dialog.Root open onOpenChange={(open) => { if (!open) onCancel() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[62] bg-overlay" />
        <Dialog.Content
          aria-describedby="confirm-build-description"
          onPointerDownOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
          className="fixed left-1/2 top-1/2 z-[63] w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 panel-surface p-4 shadow-xl"
        >
          <Dialog.Title className="text-sm font-semibold">确认开始构建？</Dialog.Title>
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
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={onCancel} className={`${CTL_SECONDARY} px-3`}>
              取消
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={submitting}
              className={`${CTL_PRIMARY} gap-1.5 px-3`}
            >
              {submitting ? <Loader2 aria-hidden size={13} className="animate-spin" /> : null}
              {submitting ? '提交中…' : '确认并开始构建'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
