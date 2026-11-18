import * as Dialog from '@radix-ui/react-dialog'
import { Info, Play, RotateCw, Square, Terminal as TerminalIcon, Trash2 } from '../../components/icons'
import { useId, useRef, useState } from 'react'
import type { Container } from '@elysian/contracts'
import { CONTAINER_STATUS_LABELS, classifyPortBind } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { StatusTag } from '../../components/StatusTag'
import type { StatusTone } from '../../components/StatusTag'
import { formatUptime } from '../../components/format'
import { CTL_CARD_ACTION, CTL_STAT, CTL_TILE } from '../../components/formControl'
import { isDockerRuntime } from '../../app/runtime/isDockerRuntime'
import {
  containerRestartConfirmDescription,
  containerRemoveBlockedReason,
  containerStopConfirmDescription,
} from './containerCopy'
import { useContainersStore } from '../../stores/containersStore'
import { Button } from '../../components/Button'

const STATUS_TONE: Record<Container['status'], StatusTone> = {
  running: 'success',
  stopped: 'neutral',
  restarting: 'warning',
  paused: 'warning',
}

function portBindLabel(hostIp: string | undefined): string | null {
  const kind = classifyPortBind(hostIp)
  if (kind === 'local') return '仅本机'
  if (kind === 'public') return '对外'
  if (kind === 'address') return hostIp ?? null
  return null
}

type ConfirmAction = 'stop' | 'restart' | 'remove'

function confirmCopy(action: ConfirmAction, name: string) {
  const docker = isDockerRuntime()
  if (action === 'remove') return {
    title: `确认删除容器「${name}」？`,
    description: `此操作无法撤销。容器可写层中的数据将丢失，镜像、挂载卷和宿主机文件会保留。${docker ? '' : '此操作仅影响演示数据。'}`,
    confirmLabel: '确认删除',
  }
  return {
    title: action === 'stop' ? `确认停止容器「${name}」？` : `确认重启容器「${name}」？`,
    description:
      action === 'stop'
        ? containerStopConfirmDescription(docker)
        : containerRestartConfirmDescription(docker),
    confirmLabel: action === 'stop' ? '确认停止' : '确认重启',
  }
}

export function ContainerCard({ container }: { container: Container }) {
  const gateway = useGateway()
  const sample = useContainersStore((s) => s.samples[container.id])
  const image = useContainersStore((s) => s.images.find((i) => i.id === container.imageId))
  const busy = useContainersStore((s) => s.busyActions.some((key) => key.startsWith(`${container.id}:`)))
  const removing = useContainersStore((s) => s.busyActions.includes(`${container.id}:remove`))
  const openDetail = useContainersStore((s) => s.openDetail)
  const openTerminal = useContainersStore((s) => s.openTerminal)
  const runAction = useContainersStore((s) => s.runAction)
  const removeContainer = useContainersStore((s) => s.removeContainer)
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null)
  const confirmTrigger = useRef<HTMLButtonElement>(null)
  const cancelButton = useRef<HTMLButtonElement>(null)
  const detailButton = useRef<HTMLButtonElement>(null)
  const removeReasonId = useId()
  const removeReason = removing ? '正在删除容器…' : containerRemoveBlockedReason(container, busy)
  const copy = confirmAction && confirmCopy(confirmAction, container.name)

  const pausedBlocked = container.status === 'paused'
  const pausedTitle = '容器已暂停，面板暂不支持恢复'
  const actionsDisabled = busy || container.status === 'restarting' || pausedBlocked
  const cpu = sample ? `${sample.cpuPercent}%` : '—'
  const memory = sample ? `${sample.memMb} MB` : '—'

  return (
    <article
      aria-label={container.name}
      className={`flex h-full flex-col gap-2 panel-surface p-4 ${
        container.status === 'stopped' ? 'border-dashed' : ''
      }`}
    >
      {/* 不用 header 元素：测试工具链将其一律算作 banner 角色，会与顶栏 banner 冲突。 */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{container.name}</h3>
          <code
            className="mt-0.5 block truncate text-xs text-fg-subtle"
            title="容器 ID 短号，终端与详情面板以它定位容器"
          >
            {container.id.slice(0, 13)}
          </code>
        </div>
        <StatusTag
          label={CONTAINER_STATUS_LABELS[container.status]}
          tone={STATUS_TONE[container.status]}
        />
      </div>

      <div className="tile">
        <p>
          镜像{' '}
          <span className="text-fg">
            {image ? `${image.name}:${image.tag}` : (container.imageRef ?? container.imageId)}
          </span>
        </p>
      </div>

      <div className="tile">
        <p className="font-medium text-fg-muted">端口映射</p>
        {container.ports.length ? (
          /* 用 span 而不是嵌套 ul：嵌套的 listitem 会被外层「容器列表」的角色查询一并抓到。 */
          <div className="mt-1.5 flex flex-wrap gap-1">
            {container.ports.map((port) => {
              const bindLabel = portBindLabel(port.hostIp)
              return (
              <span
                key={`${port.containerPort}-${port.hostPort}-${port.protocol}`}
                className={CTL_STAT}
                title={`容器内端口 ${port.containerPort} 映射到宿主机端口 ${port.hostPort}（${port.protocol}）`}
              >
                <span className="px-1.5 py-1 text-fg-muted">{port.containerPort}</span>
                <span aria-hidden="true" className="px-0.5 py-1 text-fg-subtle">
                  {' → '}
                </span>
                <span className="px-1.5 py-1 font-medium text-fg">
                  {port.hostPort}
                </span>
                <span className="px-1.5 py-1 uppercase tracking-wide text-fg-subtle">
                  /{port.protocol}
                </span>
                {bindLabel ? (
                  <span className="px-1.5 py-1 text-fg-muted">{bindLabel}</span>
                ) : null}
              </span>
            )})}
          </div>
        ) : (
          <p className="mt-1.5">无</p>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2">
        <p className={CTL_TILE}>
          <span className="block text-xs text-fg-subtle">CPU </span>
          <span className="mt-0.5 block text-sm font-medium tabular-nums text-fg">{cpu}</span>
        </p>
        <p className={CTL_TILE}>
          <span className="block text-xs text-fg-subtle">内存 </span>
          <span className="mt-0.5 block text-sm font-medium tabular-nums text-fg">{memory}</span>
        </p>
        <p className={CTL_TILE}>
          <span className="block text-xs text-fg-subtle">运行时长 </span>
          <span className="mt-0.5 block text-xs tabular-nums text-fg">
            {formatUptime(container.startedAt, new Date())}
          </span>
        </p>
      </div>

      <div className="mt-auto flex flex-wrap items-center gap-2">
        <Button variant="outline"
          type="button"
          className={CTL_CARD_ACTION}
          disabled={container.status !== 'running'}
          title={pausedBlocked ? pausedTitle : undefined}
          onClick={() => void openTerminal(gateway, container.id)}
        >
          <TerminalIcon aria-hidden size={13} />
          终端
        </Button>
        <Button ref={detailButton} variant="outline" type="button" className={CTL_CARD_ACTION} onClick={() => openDetail(container.id)}>
          <Info aria-hidden size={13} />
          详情
        </Button>
        {container.status === 'stopped' ? (
          <Button variant="outline"
            type="button"
            className={CTL_CARD_ACTION}
            disabled={actionsDisabled}
            title={pausedBlocked ? pausedTitle : undefined}
            onClick={() => void runAction(gateway, container.id, 'start')}
          >
            <Play aria-hidden size={13} />
            启动
          </Button>
        ) : (
          <Button variant="outline"
            type="button"
            className={CTL_CARD_ACTION}
            disabled={actionsDisabled}
            title={pausedBlocked ? pausedTitle : undefined}
            onClick={(event) => { confirmTrigger.current = event.currentTarget; setConfirmAction('stop') }}
          >
            <Square aria-hidden size={13} />
            停止
          </Button>
        )}
        <Button variant="outline"
          type="button"
          className={CTL_CARD_ACTION}
          disabled={actionsDisabled || container.status === 'stopped'}
          title={pausedBlocked ? pausedTitle : undefined}
          onClick={(event) => { confirmTrigger.current = event.currentTarget; setConfirmAction('restart') }}
        >
          <RotateCw aria-hidden size={13} />
          重启
        </Button>
        <span className="inline-flex" title={removeReason}>
          <Button
            variant="destructive"
            type="button"
            className={CTL_CARD_ACTION}
            disabled={Boolean(removeReason)}
            isLoading={removing}
            aria-describedby={removeReason ? removeReasonId : undefined}
            leftIcon={<Trash2 aria-hidden size={13} />}
            onClick={(event) => { confirmTrigger.current = event.currentTarget; setConfirmAction('remove') }}
          >
            删除
          </Button>
          {removeReason ? <span id={removeReasonId} className="sr-only">{removeReason}</span> : null}
        </span>
      </div>

      {confirmAction && copy ? (
        <Dialog.Root
          open
          onOpenChange={(open) => {
            if (!open) setConfirmAction(null)
          }}
        >
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay" />
            <Dialog.Content
              onOpenAutoFocus={(event) => { event.preventDefault(); cancelButton.current?.focus() }}
              onCloseAutoFocus={(event) => {
                event.preventDefault()
                const trigger = confirmTrigger.current
                if (trigger?.isConnected && !trigger.disabled) trigger.focus()
                else detailButton.current?.focus()
              }}
              className="fixed left-1/2 top-1/2 z-[61] w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 panel-surface p-4 shadow-xl"
            >
              <Dialog.Title className="break-all text-sm font-semibold">
                {copy.title}
              </Dialog.Title>
              <Dialog.Description className="mt-1.5 text-xs text-fg-muted">{copy.description}</Dialog.Description>
              {confirmAction === 'remove' && removeReason ? <p role="status" className="mt-2 text-xs text-warning">{removeReason}</p> : null}
              <div className="mt-4 flex justify-end gap-2">
                <Button ref={cancelButton} variant="outline"
                  type="button"
                  onClick={() => setConfirmAction(null)}
                  className="rounded-lg border border-line px-3 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg"
                >
                  取消
                </Button>
                <Button variant={confirmAction === 'restart' ? 'warning' : 'destructive'}
                  type="button"
                  disabled={confirmAction === 'remove' ? Boolean(removeReason) : actionsDisabled}
                  onClick={() => {
                    const action = confirmAction
                    setConfirmAction(null)
                    if (action === 'remove') void removeContainer(gateway, container.id)
                    else void runAction(gateway, container.id, action)
                  }}
                  className="px-3 text-xs"
                >
                  {copy.confirmLabel}
                </Button>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      ) : null}
    </article>
  )
}
