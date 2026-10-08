import * as Dialog from '@radix-ui/react-dialog'
import * as Popover from '@radix-ui/react-popover'
import { useEffect, useRef, useState } from 'react'
import type { DependencySetupStep } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { IconButton } from '../../components/IconButton'
import { Check, CircleHelp, Loader2, TriangleAlert, X } from '../../components/icons'
import {
  caddyGuideVisible,
  dockerGuideVisible,
  useDependencyGuideStore,
} from '../../stores/dependencyGuideStore'
import type { DependencyStageStatus } from '../../stores/dependencyGuideStore'
import { DEPENDENCY_GUIDE_CONTENT } from './dependencyGuideCopy'
import type { DependencyGuideKind, DependencyGuideStage, DependencyGuideStageId } from './dependencyGuideCopy'

/**
 * 依赖引导层：叠加在页面四状态与域级状态层之上的弹窗。
 * 优先级编排全在 store：Docker 未就绪时任何页面只弹 Docker，Caddy 以 Docker 就绪为前置且仅 missing 才引导。
 * 弹窗里的步骤全部同时留在窗口中；用户点一次「开始安装」后面板依次执行，一步成功就滑到下一步。
 * 最后一步只重新探测，转就绪时调 reload 重入页面业务加载。
 */

const STAGE_STATUS_LABEL: Record<DependencyStageStatus, string> = {
  pending: '等待',
  running: '正在执行',
  done: '已完成',
  failed: '未完成',
}

const STAGE_DOT_STYLE: Record<DependencyStageStatus, string> = {
  pending: 'bg-fg-subtle/30',
  running: 'bg-fg-subtle/30 ring-2 ring-fg-subtle/50 ring-offset-2 ring-offset-surface',
  done: 'bg-success shadow-[0_0_8px] shadow-success/35',
  failed: 'bg-danger',
}

/** 测试里不等待，避免滑动停顿拖慢用例；界面上留半秒让人看清这一步已经完成。 */
const SLIDE_PAUSE_MS = import.meta.env.MODE === 'test' ? 0 : 450

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function DependencyGuideDialogs({
  scope,
  reload,
}: {
  scope: 'docker-dependent' | 'websites'
  reload: () => void
}) {
  const gateway = useGateway()
  const report = useDependencyGuideStore((s) => s.report)
  const dismissedDocker = useDependencyGuideStore((s) => s.dismissedDocker)
  const dismissedCaddy = useDependencyGuideStore((s) => s.dismissedCaddy)
  const recheck = useDependencyGuideStore((s) => s.recheck)
  const dismissDocker = useDependencyGuideStore((s) => s.dismissDocker)
  const dismissCaddy = useDependencyGuideStore((s) => s.dismissCaddy)
  const muteGuide = useDependencyGuideStore((s) => s.muteGuide)

  const showDocker = dockerGuideVisible(report, dismissedDocker)
  // caddyGuideVisible 已含 Docker 就绪前置，两弹窗不会同时出现；Caddy 分支只挂网站页。
  const showCaddy = scope === 'websites' && caddyGuideVisible(report, dismissedCaddy)

  const verifyReady = async () => {
    const becameReady = await recheck(gateway)
    if (becameReady !== null) reload()
    return becameReady
  }

  return (
    <>
      {showDocker ? (
        <DependencyGuideDialog
          kind="docker"
          detail={report?.docker.detail ?? null}
          onVerify={verifyReady}
          onDismiss={dismissDocker}
          onMute={() => muteGuide('docker')}
        />
      ) : null}
      {showCaddy ? (
        <DependencyGuideDialog
          kind="caddy"
          detail={report?.caddy.detail ?? null}
          onVerify={verifyReady}
          onDismiss={dismissCaddy}
          onMute={() => muteGuide('caddy')}
        />
      ) : null}
    </>
  )
}

function statusIcon(status: DependencyStageStatus) {
  if (status === 'running') return <Loader2 aria-hidden className="size-3.5 shrink-0 animate-spin" />
  if (status === 'done') return <Check aria-hidden className="size-3.5 shrink-0 text-success" />
  if (status === 'failed') return <TriangleAlert aria-hidden className="size-3.5 shrink-0 text-danger" />
  return null
}

/**
 * 标题右侧的问号：这套引导在做什么，点开才显示，不占弹窗正文。
 * 浮层不走 Portal——Dialog 是模态的，portal 到 body 的浮层会被它的 pointer-events 屏蔽。
 */
function GuideHelp({ title, paragraphs }: { title: string; paragraphs: readonly string[] }) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={`${title} 说明`}
          className="inline-flex size-4 items-center justify-center rounded text-fg-subtle outline-none transition-colors hover:text-fg focus-visible:ring-2 focus-visible:ring-info"
        >
          <CircleHelp aria-hidden size={13} />
        </button>
      </Popover.Trigger>
      <Popover.Content
        side="bottom"
        align="start"
        sideOffset={6}
        collisionPadding={8}
        aria-label={`${title} 说明`}
        className="z-[60] w-80 space-y-2 rounded-lg border border-control-line bg-surface-raised p-3 text-xs leading-relaxed text-fg-muted shadow-lg"
      >
        {paragraphs.map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
        <Popover.Arrow className="fill-surface-raised" />
      </Popover.Content>
    </Popover.Root>
  )
}

function isHostStep(id: DependencyGuideStageId): id is DependencySetupStep {
  return id !== 'verify'
}

function DependencyGuideDialog({
  kind,
  detail,
  onVerify,
  onDismiss,
  onMute,
}: {
  kind: DependencyGuideKind
  /** 当前探测的非就绪原因，仅开发环境显示。 */
  detail: string | null
  onVerify: () => Promise<'docker' | 'caddy' | null>
  onDismiss: () => void
  onMute: () => void
}) {
  const gateway = useGateway()
  const content = DEPENDENCY_GUIDE_CONTENT[kind]
  const stages = content.stages
  // 进度存在 store：关掉弹窗或切页再回来仍停在原步骤，不在这里重新归零。
  const statuses = useDependencyGuideStore((state) => state.progress[kind].statuses)
  const active = useDependencyGuideStore((state) => state.progress[kind].active)
  const failure = useDependencyGuideStore((state) => state.progress[kind].failure)
  const patchProgress = useDependencyGuideStore((state) => state.patchProgress)
  const [running, setRunning] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const cardRefs = useRef<Array<HTMLElement | null>>([])
  const runToken = useRef<object | null>(null)
  const lock = useRef(false)

  const markStage = (index: number, status: DependencyStageStatus) => {
    const current = useDependencyGuideStore.getState().progress[kind].statuses
    patchProgress(kind, {
      statuses: current.map((value, position) => (position === index ? status : value)),
    })
  }

  useEffect(() => () => {
    runToken.current = null
  }, [])

  const scrollTo = (index: number) => {
    const node = cardRefs.current[index]
    if (!node) return
    try {
      node.scrollIntoView({
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
        inline: 'center',
        block: 'nearest',
      })
    } catch {
      node.scrollIntoView()
    }
  }

  const runFrom = async (start: number) => {
    if (lock.current) return
    lock.current = true
    const token = {}
    runToken.current = token
    setRunning(true)
    patchProgress(kind, { failure: null })
    try {
      for (let index = start; index < stages.length; index += 1) {
        if (runToken.current !== token) return
        patchProgress(kind, { active: index })
        scrollTo(index)
        markStage(index, 'running')
        const stage = stages[index]
        if (stage === undefined) return
        const result = await runStage(stage)
        if (runToken.current !== token) return
        if (!result.ok) {
          markStage(index, 'failed')
          patchProgress(kind, { failure: result.message })
          return
        }
        markStage(index, 'done')
        if (index < stages.length - 1) await delay(SLIDE_PAUSE_MS)
      }
    } catch (error) {
      if (runToken.current !== token) return
      patchProgress(kind, {
        failure: error instanceof Error ? error.message : '这一步没有完成',
        statuses: useDependencyGuideStore
          .getState()
          .progress[kind].statuses.map((status) => (status === 'running' ? 'failed' : status)),
      })
    } finally {
      lock.current = false
      if (runToken.current === token) setRunning(false)
    }
  }

  const runStage = async (stage: DependencyGuideStage): Promise<{ ok: boolean; message: string }> => {
    if (!isHostStep(stage.id)) {
      const before = useDependencyGuideStore.getState().report
      const became = await onVerify()
      if (became !== null) return { ok: true, message: content.successNotice }
      const after = useDependencyGuideStore.getState().report
      if (after === before) return { ok: false, message: '依赖检测失败' }
      const probe = kind === 'docker' ? after?.docker : after?.caddy
      if (probe?.state === 'ok') return { ok: true, message: content.successNotice }
      return { ok: false, message: probe?.detail ?? '仍未接通' }
    }
    return gateway.dependencies.setup(kind, stage.id)
  }

  const failedIndex = statuses.findIndex((status) => status === 'failed')
  const buttonLabel = running ? '正在执行…' : failedIndex >= 0 ? '重试' : '开始安装'
  const startAt = failedIndex >= 0 ? failedIndex : Math.max(0, statuses.findIndex((status) => status !== 'done'))

  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next) onDismiss()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-overlay" />
        <Dialog.Content
          ref={contentRef}
          tabIndex={-1}
          onPointerDownOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
          // 打开时 Radix 会把焦点落到第一个按钮（关闭）上，浏览器因此画出焦点环。
          // 焦点改到窗口本身，窗口不画环；键盘 Tab 到按钮时环仍在。
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            contentRef.current?.focus()
          }}
          aria-busy={running}
          className="fixed left-1/2 top-1/2 z-[55] flex max-h-[min(40rem,calc(100vh-3rem))] w-[min(44rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden panel-surface shadow-2xl focus-visible:outline-none"
        >
          <Dialog.Title className="sr-only">{content.title}</Dialog.Title>
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
            <span className="flex items-center gap-1.5 text-sm font-medium text-fg">
              {content.title}
              <GuideHelp title={content.title} paragraphs={content.help} />
            </span>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="关闭弹窗"
                className="inline-flex size-7 items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg"
              >
                <X aria-hidden size={15} />
              </button>
            </Dialog.Close>
          </div>

          <div className="flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto px-4 py-4">
            {import.meta.env.DEV && detail ? (
              <p className="rounded-lg bg-surface-raised px-3 py-2 text-xs text-fg-muted">
                当前探测结果：{detail}
              </p>
            ) : null}
            <div
              aria-label="安装步骤页面"
              className="flex min-w-0 snap-x snap-mandatory gap-3 overflow-x-auto scroll-smooth [scrollbar-width:none] [&::-webkit-scrollbar]:hidden motion-reduce:scroll-auto"
            >
              {stages.map((stage, index) => {
                const status = statuses[index] ?? 'pending'
                const current = index === active
                return (
                  <article
                    key={stage.id}
                    data-stage={stage.id}
                    data-active={current ? 'true' : 'false'}
                    ref={(node) => {
                      cardRefs.current[index] = node
                    }}
                    className={`w-[78%] shrink-0 snap-center rounded-lg border px-3 py-3 ${current ? 'border-fg-subtle' : 'border-line'}`}
                  >
                    <h3 className="text-sm font-medium text-fg">{stage.title}</h3>
                    <p className="mt-1 text-xs leading-relaxed text-fg-muted">{stage.detail}</p>
                    <p className="mt-3 flex items-center gap-1.5 text-xs text-fg">
                      {statusIcon(status)}
                      <span>{STAGE_STATUS_LABEL[status]}</span>
                    </p>
                    {status === 'failed' && failure ? (
                      <p role="alert" className="mt-2 text-xs text-danger">{failure}</p>
                    ) : null}
                  </article>
                )
              })}
            </div>
            <ol aria-label="安装步骤" className="flex items-center justify-center gap-2">
              {stages.map((stage, index) => {
                const status = statuses[index] ?? 'pending'
                return (
                  <li key={stage.id} aria-current={index === active ? 'step' : undefined}>
                    <IconButton
                      label={`${stage.title}：${STAGE_STATUS_LABEL[status]}`}
                      variant="ghost"
                      onPress={() => scrollTo(index)}
                    >
                      <span aria-hidden className={`size-2.5 rounded-full transition-colors ${STAGE_DOT_STYLE[status]}`} />
                    </IconButton>
                  </li>
                )
              })}
            </ol>
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-2.5">
            <button
              type="button"
              onClick={onMute}
              className="rounded-lg px-3 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg"
            >
              不再提示
            </button>
            <button
              type="button"
              onClick={() => {
                void runFrom(startAt)
              }}
              disabled={running}
              className="rounded-lg border border-control-line bg-surface-raised px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:border-fg-subtle disabled:cursor-not-allowed disabled:opacity-50"
            >
              {buttonLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
