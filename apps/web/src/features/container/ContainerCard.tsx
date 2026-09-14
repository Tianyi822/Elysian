import { Info, Play, RotateCw, Square, Terminal as TerminalIcon } from 'lucide-react'
import type { Container } from '@elysian/contracts'
import { CONTAINER_STATUS_LABELS } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { formatPort, formatUptime } from '../../adapters/mock/containerViews'
import { useContainersStore } from '../../stores/containersStore'

const STATUS_STYLE: Record<Container['status'], { icon: typeof Play; className: string }> = {
  running: { icon: Play, className: 'text-success' },
  stopped: { icon: Square, className: 'text-fg-subtle' },
  restarting: { icon: RotateCw, className: 'text-warning' },
}

const ACTION_BUTTON =
  'inline-flex items-center gap-1 rounded border border-line px-2 py-1 text-xs text-fg-muted transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-50'

export function ContainerCard({ container }: { container: Container }) {
  const gateway = useGateway()
  const sample = useContainersStore((s) => s.samples[container.id])
  const image = useContainersStore((s) => s.images.find((i) => i.id === container.imageId))
  const busy = useContainersStore((s) => s.busyActions.some((key) => key.startsWith(`${container.id}:`)))
  const openDetail = useContainersStore((s) => s.openDetail)
  const openTerminal = useContainersStore((s) => s.openTerminal)
  const runAction = useContainersStore((s) => s.runAction)

  const style = STATUS_STYLE[container.status]
  const StatusIcon = style.icon
  const actionsDisabled = busy || container.status === 'restarting'
  const cpu = sample ? `${sample.cpuPercent}%` : '—'
  const memory = sample ? `${sample.memMb} MB` : '—'

  return (
    <article
      aria-label={container.name}
      className={`flex h-full flex-col rounded-xl border border-line bg-surface p-4 ${
        container.status === 'stopped' ? 'opacity-75' : ''
      }`}
    >
      <div className="flex items-center gap-2">
        <StatusIcon aria-hidden size={14} className={style.className} />
        <h3 className="text-sm font-semibold">{container.name}</h3>
        <code className="text-xs text-fg-subtle">{container.id.slice(0, 13)}</code>
        <span className={`ml-auto text-xs font-medium ${style.className}`}>
          {CONTAINER_STATUS_LABELS[container.status]}
        </span>
      </div>

      <p className="mt-2 text-xs text-fg-muted">
        镜像 {image ? `${image.name}:${image.tag}` : container.imageId}
      </p>

      <div className="mt-2 text-xs text-fg-muted">
        <p className="font-medium text-fg-muted">端口映射</p>
        {container.ports.length ? (
          <div className="mt-1 space-y-0.5">
            {container.ports.map((port) => (
              <p key={`${port.containerPort}-${port.hostPort}-${port.protocol}`} className="tabular-nums">
                {formatPort(port)}
              </p>
            ))}
          </div>
        ) : (
          <p className="mt-1">无</p>
        )}
      </div>

      <p className="mt-2 text-xs tabular-nums text-fg">
        CPU {cpu} · 内存 {memory}
      </p>
      <p className="mt-1 text-xs text-fg-muted">运行 {formatUptime(container.startedAt, new Date())}</p>

      <div className="mt-auto flex flex-wrap items-center gap-2 pt-3">
        <button
          type="button"
          className={ACTION_BUTTON}
          disabled={container.status !== 'running'}
          onClick={() => openTerminal(container.id)}
        >
          <TerminalIcon aria-hidden size={13} />
          终端
        </button>
        <button type="button" className={ACTION_BUTTON} onClick={() => openDetail(container.id)}>
          <Info aria-hidden size={13} />
          详情
        </button>
        {container.status === 'stopped' ? (
          <button
            type="button"
            className={ACTION_BUTTON}
            disabled={actionsDisabled}
            onClick={() => void runAction(gateway, container.id, 'start')}
          >
            <Play aria-hidden size={13} />
            启动
          </button>
        ) : (
          <button
            type="button"
            className={ACTION_BUTTON}
            disabled={actionsDisabled}
            onClick={() => void runAction(gateway, container.id, 'stop')}
          >
            <Square aria-hidden size={13} />
            停止
          </button>
        )}
        <button
          type="button"
          className={ACTION_BUTTON}
          disabled={actionsDisabled || container.status === 'stopped'}
          onClick={() => void runAction(gateway, container.id, 'restart')}
        >
          <RotateCw aria-hidden size={13} />
          重启
        </button>
      </div>
    </article>
  )
}
