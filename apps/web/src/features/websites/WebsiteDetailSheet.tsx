import * as Dialog from '@radix-ui/react-dialog'
import { useRef } from 'react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import {
  WEBSITE_CATEGORY_LABELS,
  WEBSITE_CERT_STATE_LABELS,
  WEBSITE_PROJECT_KIND_LABELS,
  WEBSITE_RUN_STATE_LABELS,
  websiteProjectUsesPort,
} from '@elysian/contracts'
import type { WebsiteProject } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { CopyButton } from '../../components/CopyButton'
import { IconButton } from '../../components/IconButton'
import { RefreshCw, X } from '../../components/icons'
import { formatDate } from '../../components/format'
import { StatusTag } from '../../components/StatusTag'
import type { StatusTone } from '../../components/StatusTag'
import { useWebsitesStore } from '../../stores/websitesStore'

/* 与容器卡片同一套状态配色：状态一律「文字 + 颜色」表达。 */
const RUN_STATE_TONE: Record<WebsiteProject['runState'], StatusTone> = {
  running: 'success',
  stopped: 'neutral',
}

const CERT_TONE: Record<WebsiteProject['cert'], StatusTone> = {
  deployed: 'success',
  expired: 'danger',
  none: 'neutral',
}

/** 今日流量：满 1 GB 换算成 GB 保留一位小数，否则按 MB 展示。 */
function formatTodayTraffic(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`
}

/** 分节卡片：与容器抽屉的内部信息块同一视觉语言（圆角描边、抬升底色）；action 放节标题右侧的次要控件。 */
function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-surface-raised px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-fg-muted">{title}</h3>
        {action}
      </div>
      <div className="mt-2 space-y-1.5">{children}</div>
    </section>
  )
}

/** 键值行：标签列定宽，值列右对齐，同节内各行的值从同一条线开始。 */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[4.5rem_1fr] items-baseline gap-3">
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className="flex min-w-0 items-baseline justify-end gap-1 text-sm text-fg">{children}</dd>
    </div>
  )
}

/** 右侧滑出的项目详情面板：Esc 与点遮罩可关，同一时间只开一个。 */
export function WebsiteDetailSheet() {
  const gateway = useGateway()
  const detailTarget = useWebsitesStore((s) => s.detailTarget)
  const detailLogs = useWebsitesStore((s) => s.detailLogs)
  const detailLogsLoading = useWebsitesStore((s) => s.detailLogsLoading)
  const closeDetail = useWebsitesStore((s) => s.closeDetail)
  const reloadDetailLogs = useWebsitesStore((s) => s.reloadDetailLogs)
  // 关闭瞬间目标已被清空，冻结最后一份项目给退出动画当内容，
  // open 与「组件存活」解耦后 Radix 才有机会播完 data-state=closed 的动画。
  const lastRef = useRef(detailTarget)
  if (detailTarget) lastRef.current = detailTarget
  const project = detailTarget ?? lastRef.current

  if (!project) return null

  return (
    <Dialog.Root
      open={Boolean(detailTarget)}
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
                <Dialog.Title className="text-base font-semibold">{project.name}</Dialog.Title>
                <StatusTag
                  label={WEBSITE_RUN_STATE_LABELS[project.runState]}
                  tone={RUN_STATE_TONE[project.runState]}
                />
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                <span className="rounded bg-warning/15 px-1.5 py-0.5 font-medium text-warning">
                  演示 · 待接入真实执行
                </span>
                <StatusTag label={WEBSITE_PROJECT_KIND_LABELS[project.kind]} />
                <StatusTag label={WEBSITE_CATEGORY_LABELS[project.category]} />
              </div>
            </div>
            <Dialog.Close asChild>
              <span>
                {/* Dialog 聚焦关闭按钮会顺带打开 tooltip，其浮层压住 dialog 导致 Esc 失灵，视觉提示关掉。 */}
                <IconButton label="关闭抽屉" variant="ghost" tooltip={false}>
                  <X aria-hidden size={16} />
                </IconButton>
              </span>
            </Dialog.Close>
          </div>

          <div className="mt-4 space-y-3">
            <Section title="基本信息">
              <dl className="space-y-1.5">
                <Row label="类型">{WEBSITE_PROJECT_KIND_LABELS[project.kind]}</Row>
                <Row label="分类">{WEBSITE_CATEGORY_LABELS[project.category]}</Row>
                <Row label="运行状态">{WEBSITE_RUN_STATE_LABELS[project.runState]}</Row>
                {websiteProjectUsesPort(project.kind) && (
                  <>
                    <Row label="PID">
                      <span className="tabular-nums">{project.pid ?? '—'}</span>
                    </Row>
                    <Row label="端口">
                      <span className="tabular-nums">{project.port ?? '—'}</span>
                    </Row>
                  </>
                )}
                {project.runtimeVersion !== null && (
                  <Row label="Node版本">
                    <span className="tabular-nums">{project.runtimeVersion}</span>
                  </Row>
                )}
                <Row label="根目录">
                  <Link
                    to={`/files${project.rootDir}`}
                    className="break-all text-accent hover:underline"
                  >
                    {project.rootDir}
                  </Link>
                </Row>
                <Row label="到期时间">
                  {project.expiryAt ? (
                    <span className="tabular-nums">{formatDate(project.expiryAt)}</span>
                  ) : (
                    '长期有效'
                  )}
                </Row>
                <Row label="SSL证书">
                  <StatusTag
                    label={WEBSITE_CERT_STATE_LABELS[project.cert]}
                    tone={CERT_TONE[project.cert]}
                  />
                </Row>
                <Row label="备注">
                  <span className="break-all">{project.note ?? '—'}</span>
                </Row>
              </dl>
            </Section>

            <Section
              title="部署命令"
              action={
                project.deployCommand ? (
                  <CopyButton
                    label="部署命令"
                    value={project.deployCommand}
                    tooltip="复制部署命令"
                  />
                ) : undefined
              }
            >
              {project.deployCommand ? (
                <code className="block break-all rounded border border-line bg-surface px-2 py-1.5 font-mono text-xs text-fg">
                  {project.deployCommand}
                </code>
              ) : (
                <p className="text-sm text-fg-muted">静态站点由 Nginx 直接托管，无部署命令</p>
              )}
            </Section>

            <Section title="流量">
              <dl className="space-y-1.5">
                <Row label="今日流量">
                  <span className="tabular-nums">{formatTodayTraffic(project.traffic.todayMb)}</span>
                </Row>
                <Row label="累计流量">
                  <span className="tabular-nums">{project.traffic.totalGb} GB</span>
                </Row>
              </dl>
            </Section>

            <Section
              title="运行日志"
              action={
                <IconButton
                  label="刷新日志"
                  variant="ghost"
                  disabled={detailLogsLoading}
                  onPress={() => void reloadDetailLogs(gateway)}
                >
                  <RefreshCw
                    aria-hidden
                    size={13}
                    className={detailLogsLoading ? 'animate-spin' : undefined}
                  />
                </IconButton>
              }
            >
              {detailLogsLoading ? (
                <p role="status" className="text-sm text-fg-muted">
                  正在加载运行日志…
                </p>
              ) : detailLogs && detailLogs.length > 0 ? (
                <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-all rounded border border-line bg-surface px-2 py-1.5 font-mono text-xs leading-5 text-fg">
                  {detailLogs.map((line, index) => (
                    <span key={`${index}-${line}`} className="block">
                      {line || '\u00A0'}
                    </span>
                  ))}
                </pre>
              ) : (
                <p className="text-sm text-fg-muted">暂无日志</p>
              )}
            </Section>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
