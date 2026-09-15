import * as Dialog from '@radix-ui/react-dialog'
import { X } from '../../components/icons'
import { useRef } from 'react'
import type { ReactNode } from 'react'
import { CONTAINER_STATUS_LABELS, RESTART_POLICY_LABELS } from '@elysian/contracts'
import type { Container } from '@elysian/contracts'
import { IconButton } from '../../components/IconButton'
import { StatusTag } from '../../components/StatusTag'
import type { StatusTone } from '../../components/StatusTag'
import { formatUptime } from '../../components/format'
import { useContainersStore } from '../../stores/containersStore'

/* 与容器卡片同一套状态配色：状态一律「文字 + 颜色」表达。 */
const STATUS_TONE: Record<Container['status'], StatusTone> = {
  running: 'success',
  stopped: 'neutral',
  restarting: 'warning',
}

/** 分节卡片：与容器卡片的内部信息块同一视觉语言（圆角描边、抬升底色）。 */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-surface-raised px-3 py-2.5">
      <h3 className="text-xs font-medium text-fg-muted">{title}</h3>
      <div className="mt-2 space-y-1.5">{children}</div>
    </section>
  )
}

/** 键值行：标签列定宽，值列右对齐，同节内各行的值从同一条线开始。 */
function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="grid grid-cols-[4.5rem_1fr] items-baseline gap-3">
      <span className="text-xs text-fg-muted">{label}</span>
      <span className="flex min-w-0 items-baseline justify-end gap-1 text-sm text-fg [&>span]:break-all">
        {value}
      </span>
    </div>
  )
}

/** 端口芯片：与容器卡片同款分段样式，箭头与协议弱化为次要色。 */
function PortChip({
  containerPort,
  hostPort,
  protocol,
}: {
  containerPort: number
  hostPort: number
  protocol: string
}) {
  return (
    <span
      className="inline-flex items-stretch overflow-hidden rounded border border-line bg-surface text-xs tabular-nums"
      title={`容器内端口 ${containerPort} 映射到宿主机端口 ${hostPort}（${protocol}）`}
    >
      <span className="px-1.5 py-1 text-fg">{containerPort}</span>
      <span aria-hidden="true" className="border-l border-line px-0.5 py-1 text-fg-subtle">
        {' → '}
      </span>
      <span className="border-l border-line px-1.5 py-1 font-medium text-fg">{hostPort}</span>
      <span className="border-l border-line px-1.5 py-1 uppercase tracking-wide text-fg-subtle">
        /{protocol}
      </span>
    </span>
  )
}

/** 右侧滑出的配置面板：Esc 与点遮罩可关，同一时间只开一个。 */
export function ContainerDetailSheet() {
  const selected = useContainersStore((s) => s.containers.find((c) => c.id === s.detailContainerId))
  const image = useContainersStore((s) => s.images.find((candidate) => candidate.id === selected?.imageId))
  const closeDetail = useContainersStore((s) => s.closeDetail)
  // 关闭瞬间选择已被清空，冻结最后一份容器给退出动画当内容，
  // open 与「组件存活」解耦后 Radix 才有机会播完 data-state=closed 的动画。
  const lastRef = useRef(selected)
  if (selected) lastRef.current = selected
  const container = selected ?? lastRef.current

  if (!container) return null

  return (
    <Dialog.Root
      open={Boolean(selected)}
      onOpenChange={(open) => {
        if (!open) closeDetail()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 motion-reduce:animate-none data-[state=open]:animate-drawer-overlay-in data-[state=closed]:animate-drawer-overlay-out" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col overflow-y-auto border-l border-line bg-surface p-5 shadow-xl will-change-transform motion-reduce:animate-none data-[state=open]:animate-sheet-panel-in data-[state=closed]:animate-sheet-panel-out"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Dialog.Title className="text-base font-semibold">{container.name}</Dialog.Title>
                <StatusTag
                  label={CONTAINER_STATUS_LABELS[container.status]}
                  tone={STATUS_TONE[container.status]}
                />
              </div>
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

          <div className="mt-4 space-y-3">
            <Section title="基本信息">
              <Row label="创建时间" value={container.createdAt.slice(0, 10)} />
              <Row
                label="运行时长"
                value={<span className="tabular-nums">{formatUptime(container.startedAt, new Date())}</span>}
              />
            </Section>

            <Section title="镜像">
              <Row label="名称" value={image ? `${image.name}:${image.tag}` : container.imageId} />
              <Row label="摘要" value={<span className="font-mono text-xs">{image?.digest ?? '—'}</span>} />
            </Section>

            <Section title="端口映射">
              {container.ports.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {container.ports.map((port) => (
                    <PortChip
                      key={`${port.containerPort}-${port.hostPort}`}
                      containerPort={port.containerPort}
                      hostPort={port.hostPort}
                      protocol={port.protocol}
                    />
                  ))}
                </div>
              ) : (
                <p className="text-sm text-fg-muted">无</p>
              )}
            </Section>

            <Section title="环境变量">
              {container.env.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {container.env.map((pair) => (
                    <span
                      key={pair.key}
                      className="rounded border border-line bg-surface px-2 py-1 font-mono text-xs"
                    >
                      <span className="text-fg-muted">{pair.key}</span>
                      <span aria-hidden="true" className="text-fg-subtle">
                        =
                      </span>
                      <span className="text-fg">{pair.value}</span>
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-fg-muted">无</p>
              )}
            </Section>

            <Section title="挂载卷">
              {container.volumes.length ? (
                container.volumes.map((volume) => (
                  <p key={volume.containerPath} className="break-all font-mono text-xs">
                    <span className="text-fg-muted">{volume.hostPath}</span>
                    <span aria-hidden="true" className="text-fg-subtle">
                      {' → '}
                    </span>
                    <span className="text-fg">{volume.containerPath}</span>
                  </p>
                ))
              ) : (
                <p className="text-sm text-fg-muted">无</p>
              )}
            </Section>

            <Section title="重启策略">
              <Row label="策略" value={RESTART_POLICY_LABELS[container.restartPolicy]} />
            </Section>

            <Section title="创建命令">
              <code className="block break-all rounded border border-line bg-surface px-2 py-1.5 font-mono text-xs text-fg">
                {container.command || '（沿用镜像默认入口）'}
              </code>
            </Section>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
