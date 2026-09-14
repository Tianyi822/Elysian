import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import { CONTAINER_STATUS_LABELS, RESTART_POLICY_LABELS } from '@elysian/contracts'
import { IconButton } from '../../components/IconButton'
import { formatPort, formatUptime } from '../../adapters/mock/containerViews'
import { useContainersStore } from '../../stores/containersStore'

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-4 first:mt-0">
      <h3 className="border-b border-line pb-1.5 text-xs font-medium text-fg-muted">{title}</h3>
      <div className="mt-2 space-y-1 text-sm">{children}</div>
    </section>
  )
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="shrink-0 text-xs text-fg-muted">{label}</span>
      <span className="min-w-0 break-all text-right text-sm text-fg">{value}</span>
    </div>
  )
}

/** 右侧滑出的配置面板：Esc 与点遮罩可关，同一时间只开一个。 */
export function ContainerDetailSheet() {
  const container = useContainersStore((s) => s.containers.find((c) => c.id === s.detailContainerId))
  const image = useContainersStore((s) =>
    s.images.find((candidate) => candidate.id === container?.imageId),
  )
  const closeDetail = useContainersStore((s) => s.closeDetail)

  if (!container) return null

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) closeDetail()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col overflow-y-auto border-l border-line bg-surface p-5 shadow-xl"
        >
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <Dialog.Title className="text-base font-semibold">{container.name}</Dialog.Title>
              <p className="mt-0.5 font-mono text-xs text-fg-subtle">{container.id}</p>
            </div>
            <Dialog.Close asChild>
              <span>
                {/* Dialog 聚焦关闭按钮会顺带打开 tooltip，其浮层压住 dialog 导致 Esc 失灵，视觉提示关掉。 */}
                <IconButton label="关闭详情" variant="ghost" tooltip={false}>
                  <X aria-hidden size={16} />
                </IconButton>
              </span>
            </Dialog.Close>
          </div>

          <Section title="基本信息">
            <Row label="状态" value={CONTAINER_STATUS_LABELS[container.status]} />
            <Row label="创建时间" value={container.createdAt.slice(0, 10)} />
            <Row label="运行时长" value={formatUptime(container.startedAt, new Date())} />
          </Section>

          <Section title="镜像">
            <Row label="名称" value={image ? `${image.name}:${image.tag}` : container.imageId} />
            <Row
              label="摘要"
              value={<span className="font-mono text-xs">{image?.digest ?? '—'}</span>}
            />
          </Section>

          <Section title="端口映射">
            {container.ports.length ? (
              container.ports.map((port) => (
                <p key={`${port.containerPort}-${port.hostPort}`} className="tabular-nums text-right text-sm">
                  {formatPort(port)}
                </p>
              ))
            ) : (
              <p className="text-fg-muted">无</p>
            )}
          </Section>

          <Section title="环境变量">
            {container.env.length ? (
              container.env.map((pair) => (
                <p key={pair.key} className="break-all font-mono text-xs">
                  {pair.key}={pair.value}
                </p>
              ))
            ) : (
              <p className="text-fg-muted">无</p>
            )}
          </Section>

          <Section title="挂载卷">
            {container.volumes.length ? (
              container.volumes.map((volume) => (
                <p key={volume.containerPath} className="break-all text-xs">
                  {volume.hostPath} → {volume.containerPath}
                </p>
              ))
            ) : (
              <p className="text-fg-muted">无</p>
            )}
          </Section>

          <Section title="重启策略">
            <Row label="策略" value={RESTART_POLICY_LABELS[container.restartPolicy]} />
          </Section>

          <Section title="创建命令">
            <code className="block break-all rounded border border-line bg-surface-raised px-2 py-1.5 font-mono text-xs">
              {container.command}
            </code>
          </Section>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
