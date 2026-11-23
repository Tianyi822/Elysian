import * as Dialog from '@radix-ui/react-dialog'
import * as Tooltip from '@radix-ui/react-tooltip'
import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { PanelCommit, PanelUpdateChannel, PanelUpdateSource } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { formatDateTimeWithYear } from '../../components/format'
import { X } from '../../components/icons'
import { ScrollArea } from '../../components/ScrollArea'
import { EmptyState, ErrorState, LoadingState } from '../../components/states/StateViews'
import { useMessageStore } from '../../stores/messageStore'
import { Button } from '../../components/Button'
import { Badge } from '../../components/easyui/Badge'
import { TOOLTIP_CONTENT_CLASS } from '../../components/tooltipStyles'
import { messageOf } from '../../utils/errorMessage'

/**
 * 更新日志窗口：列所选来源最近的提交标题，从新到旧。
 *
 * 数据只在窗口打开时读一次——它是只读的上游查询，不该常驻在面板 store 里，
 * 也不该在设置页每次挂载都替用户打一次 GitHub。当前运行的提交按 SHA 与
 * info.commit 比对后标注，比对不上就不硬认（安装来源未必是这条分支）。
 */
export function PanelChangelogDialog({
  currentCommit,
  channel,
  source,
  children,
}: {
  /** 正在运行的构建提交；命中列表里的某条时标为当前版本。 */
  currentCommit: string
  channel: PanelUpdateChannel
  source: PanelUpdateSource
  children: ReactElement
}) {
  const gateway = useGateway()
  const [open, setOpen] = useState(false)
  const [commits, setCommits] = useState<readonly PanelCommit[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError(null)
    void gateway.panel.commits(channel, source).then(
      (rows) => {
        if (cancelled) return
        setCommits(rows)
        setLoading(false)
        if (rows.length === 0) useMessageStore.getState().notify({ tone: 'info', message: channel === 'commit' ? '上游仓库没有返回提交记录。' : '上游仓库暂无正式发版或未返回提交记录。' })
      },
      (cause: unknown) => {
        if (cancelled) return
        setError(messageOf(cause, '读取更新日志失败'))
        setLoading(false)
      },
    )
    return () => {
      cancelled = true
    }
  }, [open, gateway, attempt, channel, source])

  const read = useCallback(() => setAttempt((value) => value + 1), [])

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>{children}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[61] flex max-h-[min(36rem,calc(100dvh-3rem))] w-[min(38rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col panel-surface shadow-xl">
          <div className="flex shrink-0 items-center justify-between gap-3 px-5 pt-5">
            <Dialog.Title className="text-sm font-semibold text-fg">更新日志</Dialog.Title>
            <Tooltip.Root>
              <Tooltip.Trigger asChild>
                <Dialog.Close asChild>
                  <Button size="icon" variant="outline" aria-label="关闭更新日志"
                    className="size-8 shrink-0 rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
                    <X aria-hidden size={16} />
                  </Button>
                </Dialog.Close>
              </Tooltip.Trigger>
              <Tooltip.Portal>
                {/* 提示显示时先收到 Escape，仍按一次关闭整个弹窗。 */}
                <Tooltip.Content side="top" sideOffset={6} className={TOOLTIP_CONTENT_CLASS} onEscapeKeyDown={() => setOpen(false)}>
                  关闭更新日志<Tooltip.Arrow className="fill-surface-raised" />
                </Tooltip.Content>
              </Tooltip.Portal>
            </Tooltip.Root>
          </div>
          <Dialog.Description className="shrink-0 px-5 pt-1 text-xs leading-5 text-fg-muted">
            {source === 'gitee' ? 'Gitee' : 'GitHub'} · 正式发版对应的提交记录，从新到旧。
          </Dialog.Description>

          <ScrollArea label="更新日志内容">
            <div className="min-w-0 px-5 py-4">
              {loading ? (
                <LoadingState label="正在读取更新日志…" />
              ) : error ? (
                <ErrorState title="更新日志读取失败" description={error} onRetry={read} />
              ) : commits.length === 0 ? (
                <EmptyState title="没有可展示的提交" description={channel === 'commit' ? '上游仓库没有返回提交记录。' : '上游仓库暂无正式发版或未返回提交记录。'} />
              ) : (
                <ol className="flex flex-col gap-2">
                  {commits.map((commit) => {
                    const isCurrent = currentCommit !== '' && commit.sha === currentCommit
                    const time = formatDateTimeWithYear(commit.time)
                    return (
                      <li
                        key={commit.sha}
                        className={`flex flex-col gap-1 rounded-lg border px-3 py-2.5 ${
                          isCurrent ? 'border-accent/50 bg-accent/10' : 'border-line'
                        }`}
                      >
                        <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
                          <p className="min-w-0 flex-1 wrap-anywhere text-xs leading-5 text-fg">{commit.message}</p>
                          {isCurrent ? (
                            <Badge tone="info" animateChanges={false} className="h-5 shrink-0 px-2 text-[0.625rem]">
                              当前版本
                            </Badge>
                          ) : null}
                        </div>
                        {time ? <time dateTime={commit.time} className="text-xs leading-5 tabular-nums text-fg-muted">{time} 北京时间</time> : null}
                      </li>
                    )
                  })}
                </ol>
              )}
            </div>
          </ScrollArea>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
