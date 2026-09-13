import { AUDIT_KIND_LABELS } from '@elysian/contracts'
import type { AuditRecord } from '@elysian/contracts'
import { useMemo, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Moon, RefreshCw, Sun, Zap } from 'lucide-react'
import { useGateway } from '../../adapters/GatewayProvider'
import { StatusTag } from '../../components/StatusTag'
import { formatDateTime } from '../../components/format'
import { useTheme } from '../../app/theme/ThemeProvider'
import { useDashboardStore } from '../../stores/dashboardStore'
import { useEventStreamStore } from '../../stores/eventStreamStore'
import { isLiveRecord, projectEventToAuditRecord } from './liveProjection'

const RECENT_LIMIT = 8

export function RecentActivitySection({ records }: { records: readonly AuditRecord[] }) {
  const recentEvents = useEventStreamStore((state) => state.recent)

  const merged = useMemo(() => {
    // 实时记录按「刚刚到达」置顶，不与种子基准时间比大小。
    const live = recentEvents.map(projectEventToAuditRecord)
    return [...live, ...records].slice(0, RECENT_LIMIT)
  }, [recentEvents, records])

  return (
    <section aria-label="最近活动" className="rounded-lg border border-line bg-surface p-3">
      <div className="mb-1.5 flex items-center justify-between border-b border-line pb-1">
        <h2 className="text-sm font-semibold">最近活动</h2>
        <span className="text-xs text-fg-muted">最新 {merged.length} 条</span>
      </div>

      {merged.length === 0 ? (
        <p className="py-4 text-center text-sm text-fg-muted">还没有任何活动记录。</p>
      ) : (
        <ol className="space-y-1">
          {merged.map((record) => (
            <li key={record.id} className="flex flex-wrap items-baseline gap-2">
              <time className="text-xs tabular-nums text-fg-subtle">
                {formatDateTime(record.at)}
              </time>
              <StatusTag label={AUDIT_KIND_LABELS[record.kind]} tone="info" />
              <span className="text-sm">{record.summary}</span>
              {isLiveRecord(record) ? (
                <span className="text-xs text-accent">实时</span>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

function ActionCard({
  label,
  description,
  icon: Icon,
  onClick,
}: {
  label: string
  description: string
  icon: typeof Zap
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2.5 rounded-lg border border-line bg-surface p-2.5 text-left transition-colors hover:border-accent/40 hover:bg-surface-raised"
    >
      <span
        aria-hidden
        className="inline-flex size-8 shrink-0 items-center justify-center rounded bg-accent/15 text-accent"
      >
        <Icon size={15} />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block truncate text-xs text-fg-muted">{description}</span>
      </span>
    </button>
  )
}

export function QuickActionsSection() {
  const gateway = useGateway()
  const { theme, toggleTheme } = useTheme()
  const load = useDashboardStore((state) => state.load)
  const refresh = useDashboardStore((state) => state.refresh)

  const [note, setNote] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [resetting, setResetting] = useState(false)

  const handleReset = async () => {
    setResetting(true)
    setError(undefined)
    try {
      await gateway.reset()
      await load(gateway)
      setConfirmOpen(false)
      setNote('演示数据已重置回种子状态。')
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : '重置演示数据失败')
    } finally {
      setResetting(false)
    }
  }

  return (
    <section aria-label="快捷操作" className="rounded-lg border border-line bg-surface p-3">
      <div className="mb-1.5 border-b border-line pb-1">
        <h2 className="text-sm font-semibold">快捷操作</h2>
      </div>

      {note ? (
        <p
          role="status"
          className="mb-2 rounded border border-success/40 bg-success/10 px-2 py-1 text-xs text-success"
        >
          {note}
        </p>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="mb-2 rounded border border-danger/40 bg-danger/10 px-2 py-1 text-xs text-danger"
        >
          {error}
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <ActionCard
          label={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
          description="切换界面配色"
          icon={theme === 'dark' ? Sun : Moon}
          onClick={() => {
            toggleTheme()
            setNote(theme === 'dark' ? '已切换到浅色主题。' : '已切换到深色主题。')
          }}
        />
        <ActionCard
          label="重置演示数据"
          description="回到初始种子状态"
          icon={RefreshCw}
          onClick={() => setConfirmOpen(true)}
        />
        <ActionCard
          label="重新连接事件源"
          description="恢复实时事件流"
          icon={Zap}
          onClick={() => {
            useEventStreamStore.getState().connect(gateway.events)
            setNote('已尝试重新连接事件源，状态见页头标识。')
          }}
        />
        <ActionCard
          label="刷新仪表盘"
          description="重新拉取全部数据"
          icon={RefreshCw}
          onClick={() => {
            setNote(undefined)
            void refresh(gateway)
          }}
        />
      </div>

      <Dialog.Root
        open={confirmOpen}
        onOpenChange={(open) => {
          setConfirmOpen(open)
          if (!open) setError(undefined)
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
          <Dialog.Content
            aria-describedby={undefined}
            className="fixed left-1/2 top-1/2 z-50 w-[min(28rem,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-line bg-surface p-3"
          >
            <Dialog.Title className="mb-1.5 text-sm font-semibold">确认重置演示数据？</Dialog.Title>
            <p className="mb-2 text-xs text-fg-muted">
              审批状态、技能启停等本地改动都会回到初始种子状态。这一步不会影响任何真实系统。
            </p>
            {error ? (
              <p
                role="alert"
                className="mb-2 rounded border border-danger/40 bg-danger/10 px-2 py-1 text-xs text-danger"
              >
                重置演示数据失败：{error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="rounded border border-line px-2 py-1 text-xs text-fg-muted"
                >
                  取消
                </button>
              </Dialog.Close>
              <button
                type="button"
                disabled={resetting}
                onClick={() => void handleReset()}
                className="rounded border border-danger/50 px-2 py-1 text-xs text-danger disabled:opacity-50"
              >
                确认重置
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  )
}
