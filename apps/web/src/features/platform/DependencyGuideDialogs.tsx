import * as Dialog from '@radix-ui/react-dialog'
import { useGateway } from '../../adapters/GatewayProvider'
import { X } from '../../components/icons'
import {
  caddyGuideVisible,
  dockerGuideVisible,
  useDependencyGuideStore,
} from '../../stores/dependencyGuideStore'
import { DEPENDENCY_GUIDE_CONTENT } from './dependencyGuideCopy'
import type { DependencyGuideKind } from './dependencyGuideCopy'

/**
 * 依赖引导层：叠加在页面四状态与域级状态层（横幅 / 错误态）之上的弹窗，
 * 只做引导不做状态常驻——安装步骤与「重新检测」入口在此，通道降级事实仍在
 * 各页既有的横幅与错误态里。挂点是三页（容器 / 数据库 scope 为 docker-dependent，
 * 网站 scope 为 websites）；优先级编排全在 store 的派生选择器：Docker 未就绪时
 * 任何页面只弹 Docker 弹窗，Caddy 弹窗以 Docker 就绪为前置且仅 missing 才引导。
 * 依赖经「重新检测」转就绪时调 reload 重入页面业务加载，四状态机制不动。
 */
export function DependencyGuideDialogs({
  scope,
  reload,
}: {
  scope: 'docker-dependent' | 'websites'
  reload: () => void
}) {
  const gateway = useGateway()
  const report = useDependencyGuideStore((s) => s.report)
  const rechecking = useDependencyGuideStore((s) => s.rechecking)
  const dismissedDocker = useDependencyGuideStore((s) => s.dismissedDocker)
  const dismissedCaddy = useDependencyGuideStore((s) => s.dismissedCaddy)
  const recheck = useDependencyGuideStore((s) => s.recheck)
  const dismissDocker = useDependencyGuideStore((s) => s.dismissDocker)
  const dismissCaddy = useDependencyGuideStore((s) => s.dismissCaddy)

  const showDocker = dockerGuideVisible(report, dismissedDocker)
  // caddyGuideVisible 已含 Docker 就绪前置，两弹窗不会同时出现；Caddy 分支只挂网站页。
  const showCaddy = scope === 'websites' && caddyGuideVisible(report, dismissedCaddy)

  const runRecheck = () => {
    void recheck(gateway).then((becameReady) => {
      // 转就绪的交接：页面可能还停在 ErrorState、横幅还挂着旧状态，重拉业务数据。
      if (becameReady !== null) reload()
    })
  }

  return (
    <>
      {showDocker ? (
        <DependencyGuideDialog
          kind="docker"
          detail={report?.docker.detail ?? null}
          rechecking={rechecking}
          onRecheck={runRecheck}
          onDismiss={dismissDocker}
        />
      ) : null}
      {showCaddy ? (
        <DependencyGuideDialog
          kind="caddy"
          detail={report?.caddy.detail ?? null}
          rechecking={rechecking}
          onRecheck={runRecheck}
          onDismiss={dismissCaddy}
        />
      ) : null}
    </>
  )
}

/**
 * 参数化的引导弹窗：Docker 与 Caddy 两个弹窗骨架完全同构，差异只在文案表
 * （DEPENDENCY_GUIDE_CONTENT）。Radix 模式照 WebsitesCreateDialog：Portal +
 * Overlay、sr-only Title 加可视标题行、右上关闭按钮、阻止误点关闭
 * （Esc 与关闭按钮仍是显式关闭）。焦点管理交给 Radix。
 */
function DependencyGuideDialog({
  kind,
  detail,
  rechecking,
  onRecheck,
  onDismiss,
}: {
  kind: DependencyGuideKind
  /** 当前探测的非就绪原因（missing / error 时恒有值），以次要文字呈现。 */
  detail: string | null
  rechecking: boolean
  onRecheck: () => void
  onDismiss: () => void
}) {
  const content = DEPENDENCY_GUIDE_CONTENT[kind]
  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next) onDismiss()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content
          onPointerDownOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
          className="fixed left-1/2 top-1/2 z-[55] flex max-h-[min(40rem,calc(100vh-3rem))] w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-line bg-bg shadow-2xl"
        >
          <Dialog.Title className="sr-only">{content.title}</Dialog.Title>
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
            <span className="text-sm font-medium text-fg">{content.title}</span>
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

          <div className="flex flex-col gap-3 overflow-y-auto px-4 py-4">
            <Dialog.Description className="text-xs leading-relaxed text-fg-muted">
              {content.lead}
            </Dialog.Description>
            {detail ? (
              <p className="rounded-lg bg-surface-raised px-3 py-2 text-xs text-fg-muted">
                当前探测结果：{detail}
              </p>
            ) : null}
            <ol className="flex list-decimal flex-col gap-2 pl-5 text-xs leading-relaxed text-fg-muted">
              {content.steps.map((step, index) => (
                <li key={index}>{step}</li>
              ))}
            </ol>
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-2.5">
            <button
              type="button"
              onClick={onRecheck}
              disabled={rechecking}
              className="rounded-lg border border-line bg-surface-raised px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:border-fg-subtle disabled:cursor-not-allowed disabled:opacity-50"
            >
              {rechecking ? '正在检测…' : '重新检测'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
