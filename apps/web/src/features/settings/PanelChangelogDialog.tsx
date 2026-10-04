import * as Dialog from '@radix-ui/react-dialog'
import { useCallback, useEffect, useState } from 'react'
import type { PanelCommit } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { formatDateTime } from '../../components/format'
import { X } from '../../components/icons'
import { IconButton } from '../../components/IconButton'
import { EmptyState, ErrorState, LoadingState } from '../../components/states/StateViews'

const BUTTON =
  'h-9 rounded-lg border border-control-line bg-surface-raised px-4 text-sm font-medium text-fg transition-colors hover:border-fg-subtle disabled:cursor-not-allowed disabled:opacity-50'

/**
 * 更新日志窗口：列上游仓库默认分支最近的提交标题，从新到旧。
 *
 * 数据只在窗口打开时读一次——它是只读的上游查询，不该常驻在面板 store 里，
 * 也不该在设置页每次挂载都替用户打一次 GitHub。当前运行的提交按 SHA 与
 * info.commit 比对后标注，比对不上就不硬认（安装来源未必是这条分支）。
 */
export function PanelChangelogDialog({
  open,
  currentCommit,
  onClose,
}: {
  open: boolean
  /** 正在运行的构建提交；命中列表里的某条时标为当前版本。 */
  currentCommit: string
  onClose: () => void
}) {
  const gateway = useGateway()
  const [commits, setCommits] = useState<readonly PanelCommit[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError(null)
    void gateway.panel.commits().then(
      (rows) => {
        if (cancelled) return
        setCommits(rows)
        setLoading(false)
      },
      (cause: unknown) => {
        if (cancelled) return
        setError(cause instanceof Error ? cause.message : '读取更新日志失败')
        setLoading(false)
      },
    )
    return () => {
      cancelled = true
    }
  }, [open, gateway, attempt])

  const read = useCallback(() => setAttempt((value) => value + 1), [])

  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[61] flex max-h-[calc(100dvh-2rem)] w-[min(38rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col panel-surface shadow-xl">
          <div className="flex shrink-0 items-center justify-between gap-3 px-5 pt-5">
            <Dialog.Title className="text-sm font-semibold text-fg">更新日志</Dialog.Title>
            <Dialog.Close asChild>
              <IconButton label="关闭更新日志" variant="ghost" tooltip={false}>
                <X aria-hidden size={16} />
              </IconButton>
            </Dialog.Close>
          </div>
          <Dialog.Description className="shrink-0 px-5 pt-1 text-xs leading-5 text-fg-muted">
            上游仓库默认分支的提交记录，从新到旧。
          </Dialog.Description>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {loading ? (
              <LoadingState label="正在读取更新日志…" />
            ) : error ? (
              <ErrorState title="更新日志读取失败" description={error} onRetry={read} />
            ) : commits.length === 0 ? (
              <EmptyState title="没有可展示的提交" description="上游仓库没有返回提交记录。" />
            ) : (
              <ol className="flex flex-col gap-2">
                {commits.map((commit) => {
                  const isCurrent = currentCommit !== '' && commit.sha === currentCommit
                  return (
                    <li
                      key={commit.sha}
                      className={`flex flex-col gap-1 rounded-lg border px-3 py-2.5 ${
                        isCurrent ? 'border-accent/50 bg-accent/10' : 'border-line'
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        <p className="min-w-0 flex-1 text-xs leading-5 text-fg">{commit.message}</p>
                        {isCurrent ? (
                          <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[0.625rem] font-medium text-accent-fg">
                            当前版本
                          </span>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap items-center gap-x-2 text-[0.625rem] leading-4 text-fg-muted">
                        <code className="break-all font-mono">{commit.sha.slice(0, 7)}</code>
                        <span className="tabular-nums">{formatDateTime(commit.time)}</span>
                      </div>
                    </li>
                  )
                })}
              </ol>
            )}
          </div>

          <div className="flex shrink-0 justify-end gap-2 px-5 py-4">
            <button type="button" className={BUTTON} disabled={loading} onClick={read}>
              {loading ? '正在读取…' : '重新读取'}
            </button>
            <Dialog.Close asChild>
              <button type="button" className={BUTTON} onClick={onClose}>
                关闭
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
