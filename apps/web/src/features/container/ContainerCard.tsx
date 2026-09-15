import { Info, Play, RotateCw, Square, Terminal as TerminalIcon } from '../../components/icons'
import type { Container } from '@elysian/contracts'
import { CONTAINER_STATUS_LABELS } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { StatusTag } from '../../components/StatusTag'
import type { StatusTone } from '../../components/StatusTag'
import { formatUptime } from '../../adapters/mock/containerViews'
import { useContainersStore } from '../../stores/containersStore'

const STATUS_TONE: Record<Container['status'], StatusTone> = {
  running: 'success',
  stopped: 'neutral',
  restarting: 'warning',
}

const ACTION_BUTTON =
  'inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-xs text-fg-muted transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-50'

export function ContainerCard({ container }: { container: Container }) {
  const gateway = useGateway()
  const sample = useContainersStore((s) => s.samples[container.id])
  const image = useContainersStore((s) => s.images.find((i) => i.id === container.imageId))
  const busy = useContainersStore((s) => s.busyActions.some((key) => key.startsWith(`${container.id}:`)))
  const openDetail = useContainersStore((s) => s.openDetail)
  const openTerminal = useContainersStore((s) => s.openTerminal)
  const runAction = useContainersStore((s) => s.runAction)

  const actionsDisabled = busy || container.status === 'restarting'
  const cpu = sample ? `${sample.cpuPercent}%` : '—'
  const memory = sample ? `${sample.memMb} MB` : '—'

  return (
    <article
      aria-label={container.name}
      className={`flex h-full flex-col gap-2 rounded-xl border border-line bg-surface p-4 ${
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

      <div className="rounded-lg bg-surface-raised px-3 py-2 text-xs text-fg-muted">
        <p>
          镜像 <span className="text-fg">{image ? `${image.name}:${image.tag}` : container.imageId}</span>
        </p>
      </div>

      <div className="rounded-lg bg-surface-raised px-3 py-2 text-xs text-fg-muted">
        <p className="font-medium text-fg-muted">端口映射</p>
        {container.ports.length ? (
          /* 用 span 而不是嵌套 ul：嵌套的 listitem 会被外层「容器列表」的角色查询一并抓到。 */
          <div className="mt-1.5 flex flex-wrap gap-1">
            {container.ports.map((port) => (
              <span
                key={`${port.containerPort}-${port.hostPort}-${port.protocol}`}
                className="inline-flex items-stretch overflow-hidden rounded border border-line bg-surface text-xs tabular-nums"
                title={`容器内端口 ${port.containerPort} 映射到宿主机端口 ${port.hostPort}（${port.protocol}）`}
              >
                <span className="px-1.5 py-1 text-fg-muted">{port.containerPort}</span>
                <span aria-hidden="true" className="border-l border-line px-0.5 py-1 text-fg-subtle">
                  {' → '}
                </span>
                <span className="border-l border-line px-1.5 py-1 font-medium text-fg">
                  {port.hostPort}
                </span>
                <span className="border-l border-line px-1.5 py-1 uppercase tracking-wide text-fg-subtle">
                  /{port.protocol}
                </span>
              </span>
            ))}
          </div>
        ) : (
          <p className="mt-1.5">无</p>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2">
        <p className="rounded-lg bg-surface-raised px-3 py-2">
          <span className="block text-xs text-fg-subtle">CPU </span>
          <span className="mt-0.5 block text-sm font-medium tabular-nums text-fg">{cpu}</span>
        </p>
        <p className="rounded-lg bg-surface-raised px-3 py-2">
          <span className="block text-xs text-fg-subtle">内存 </span>
          <span className="mt-0.5 block text-sm font-medium tabular-nums text-fg">{memory}</span>
        </p>
        <p className="rounded-lg bg-surface-raised px-3 py-2">
          <span className="block text-xs text-fg-subtle">运行时长 </span>
          <span className="mt-0.5 block text-xs tabular-nums text-fg">
            {formatUptime(container.startedAt, new Date())}
          </span>
        </p>
      </div>

      <div className="mt-auto flex flex-wrap items-center gap-2">
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
