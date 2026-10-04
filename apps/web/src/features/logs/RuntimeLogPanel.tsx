import { useEffect, useRef } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { LOG_ENTRY_FETCH_LIMIT, formatLogBytes, logRetentionText } from '@elysian/contracts'
import type { PlatformLogLevel, RuntimeLogEntry } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { isDockerRuntime } from '../../app/runtime/isDockerRuntime'
import { formatLoginTime } from '../../components/format'
import { Search } from '../../components/icons'
import { StatusTag } from '../../components/StatusTag'
import type { StatusTone } from '../../components/StatusTag'
import { EmptyState, ErrorState, LoadingState } from '../../components/states/StateViews'
import { RefreshButton } from '../../components/RefreshState'
import { CTL_CHIP, CTL_FIELD, CTL_PRIMARY, CTL_TOOLBAR } from '../../components/formControl'
import { useRuntimeLogStore } from '../../stores/runtimeLogStore'
import { ClearLogsDialog } from './ClearLogsDialog'
import { LogMessageCell } from './LogMessageCell'
import { LogTable } from './LogTable'
import type { LogColumn } from './LogTable'

/**
 * 平台运行日志面板：日期时间｜等级｜日志信息三列固定宽度表格（超出省略、点击展开悬浮窗），
 * 条目按时间倒序（新 → 旧），最新一条在最上，与操作日志同一口径。
 * 工具栏三块为搜索、视图操作（刷新日志 / 全屏展示）与日志大小 + 清空日志
 * （破坏性动作走二次确认），窄屏按块各占一行。搜索走服务端筛选并防抖。
 */

/** 工具按钮：与全站工具栏同一控件形状；给 pressed 时按筛选芯片形态高亮。 */
function ToolButton({
  label,
  onClick,
  disabled = false,
  pressed,
}: {
  label: string
  onClick?: () => void
  disabled?: boolean
  pressed?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={pressed}
      className={pressed === undefined ? CTL_PRIMARY : CTL_CHIP}
    >
      {label}
    </button>
  )
}

/** 等级 → 语义色调：等级列用 StatusTag 呈现（文字 + 颜色同时表达，不只靠颜色）；文字用原英文等级值，不译成中文。 */
export function levelTone(level: PlatformLogLevel): StatusTone {
  if (level === 'error') return 'danger'
  if (level === 'warning') return 'warning'
  if (level === 'info') return 'info'
  return 'neutral'
}

/**
 * 搜索口径：匹配 message 与 source，大小写不敏感（时间与等级在表里各有自己的列，
 * 塞进关键词匹配只会让「搜一个日期就出满屏」这种意外发生）；空关键词不过滤。
 */
export function matchesRuntimeSearch(entry: RuntimeLogEntry, keyword: string): boolean {
  if (!keyword) return true
  const needle = keyword.toLowerCase()
  return (
    entry.message.toLowerCase().includes(needle) || entry.source.toLowerCase().includes(needle)
  )
}

/**
 * 表格最小宽度类：值由 LogTable 的列宽算式算得（176 + 96 + 560 = 832），
 * Tailwind 只认字面类名，算式与字面量的一致性由测试锁住。
 */
const TABLE_MIN_WIDTH_CLASS = 'min-w-[832px]'

/** 三列：前两列固定宽度，日志信息列吃掉剩余（并有 560px 的最小宽度兜底）。 */
const RUNTIME_LOG_COLUMNS: readonly LogColumn<RuntimeLogEntry>[] = [
  {
    label: '日期时间',
    widthClass: 'w-44',
    cell: (entry) => (
      // 固定 19 字符 + 等宽字体 + tabular-nums：字符宽度统一，时间列因此不会随内容抖动。
      <td className="border-b border-line px-3 py-2.5 font-mono text-xs tabular-nums text-fg-muted">
        {formatLoginTime(entry.at)}
      </td>
    ),
  },
  {
    label: '等级',
    widthClass: 'w-24',
    cell: (entry) => (
      <td className="border-b border-line px-3 py-2.5">
        <StatusTag label={entry.level} tone={levelTone(entry.level)} />
      </td>
    ),
  },
  {
    label: '日志信息',
    cell: (entry) => (
      <LogMessageCell
        text={entry.message}
        details={
          <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-fg-muted">
            <div className="flex gap-1.5">
              <dt>时间</dt>
              <dd className="font-mono tabular-nums">{formatLoginTime(entry.at)}</dd>
            </div>
            <div className="flex gap-1.5">
              <dt>等级</dt>
              <dd className="font-mono">{entry.level}</dd>
            </div>
            <div className="flex gap-1.5">
              <dt>来源</dt>
              <dd className="font-mono">{entry.source}</dd>
            </div>
          </dl>
        }
      />
    ),
  },
]

export function RuntimeLogPanel() {
  const gateway = useGateway()
  const status = useRuntimeLogStore((s) => s.status)
  const errorMessage = useRuntimeLogStore((s) => s.errorMessage)
  const entries = useRuntimeLogStore((s) => s.entries)
  const total = useRuntimeLogStore((s) => s.total)
  const truncated = useRuntimeLogStore((s) => s.truncated)
  const skippedLines = useRuntimeLogStore((s) => s.skippedLines)
  const skippedFiles = useRuntimeLogStore((s) => s.skippedFiles)
  const storage = useRuntimeLogStore((s) => s.storage)
  const search = useRuntimeLogStore((s) => s.search)
  const fullscreen = useRuntimeLogStore((s) => s.fullscreen)
  const refreshing = useRuntimeLogStore((s) => s.refreshing)
  const loadingOlder = useRuntimeLogStore((s) => s.loadingOlder)
  const olderError = useRuntimeLogStore((s) => s.olderError)
  const load = useRuntimeLogStore((s) => s.load)
  const loadOlder = useRuntimeLogStore((s) => s.loadOlder)
  const setSearch = useRuntimeLogStore((s) => s.setSearch)
  const setFullscreen = useRuntimeLogStore((s) => s.setFullscreen)
  const openClear = useRuntimeLogStore((s) => s.openClear)

  const committedSearchRef = useRef(search.trim())
  const trimmedSearch = search.trim()

  useEffect(() => {
    const delay = trimmedSearch === committedSearchRef.current ? 0 : 300
    const handle = setTimeout(() => {
      committedSearchRef.current = trimmedSearch
      void load(gateway)
    }, delay)
    return () => clearTimeout(handle)
  }, [gateway, load, trimmedSearch])

  if (status === 'loading' || status === 'idle') {
    return <LoadingState label="正在加载运行日志…" />
  }

  if (status === 'error' || !storage) {
    return <ErrorState title="运行日志加载失败" description={errorMessage} onRetry={() => void load(gateway)} />
  }

  // 计数文案与操作日志面板共用一套口径；正常都是 0，非 0 才提示。
  const notices: string[] = []
  if (truncated) notices.push(`仅显示最近 ${LOG_ENTRY_FETCH_LIMIT} 条`)
  if (skippedLines > 0) notices.push(`有 ${skippedLines} 行无法解析，已跳过`)
  if (skippedFiles > 0) notices.push(`有 ${skippedFiles} 个日志文件读取失败，已跳过`)

  const emptyMessage =
    total === 0 && trimmedSearch.length === 0
      ? '还没有运行日志'
      : '没有匹配的运行日志，换个关键词或清空搜索'

  const querying = refreshing && !loadingOlder
  const showEmptyPage = total === 0 && trimmedSearch.length === 0

  const table = showEmptyPage ? (
    <EmptyState
      title="还没有运行日志"
      description="服务启动、请求失败与保留巡检都会写进这里，先跑起来再回来看。"
    />
  ) : (
    <LogTable
      label="运行日志表"
      minWidthClass={TABLE_MIN_WIDTH_CLASS}
      columns={RUNTIME_LOG_COLUMNS}
      rows={entries}
      rowKey={(entry) => entry.id}
      emptyMessage={emptyMessage}
      busy={querying}
    />
  )

  return (
    <div className="flex h-full flex-col gap-3">
      {/*
        工具栏三块：搜索 / 视图操作 / 日志大小与清空。窄屏（md 以下）一块一行，
        md 起回到一行三段、最后一块靠右——自由折行会把清空按钮孤零零甩到第二行。
      */}
      <div className={`${CTL_TOOLBAR} flex flex-col gap-2 panel-surface px-4 py-3 md:flex-row md:items-center`}>
        <div className="relative w-full md:w-64">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle"
          />
          <label htmlFor="runtime-log-search" className="sr-only">
            搜索日志关键字
          </label>
          <input
            id="runtime-log-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="请输入搜索关键字"
            className={`${CTL_FIELD} pl-8`}
          />
        </div>
        <div role="group" aria-label="日志视图操作" className="flex flex-wrap items-center gap-2">
          <RefreshButton
            onPress={() => void load(gateway)}
            busy={refreshing}
            label="刷新日志"
            formControl
          />
          {/* 文案固定「全屏展示」，避免与弹窗内的「退出全屏」按钮重名；开合靠 pressed 高亮表达。 */}
          <ToolButton label="全屏展示" pressed={fullscreen} onClick={() => setFullscreen(!fullscreen)} />
        </div>
        <div className="flex items-center justify-between gap-2 md:ml-auto">
          <span className="text-xs text-fg-muted">
            日志大小：<span className="tabular-nums text-fg">{formatLogBytes(storage.totalBytes)}</span>
          </span>
          {/* 危险感只在确认弹窗里呈现：工具栏按钮与其它按钮同款中性描边。 */}
          <ToolButton label="清空日志" onClick={() => openClear('runtime')} />
        </div>
      </div>

      {/* 关于数据来源与保留口径的事实说明，与控件分开：演示态、保留策略、截断与坏行计数同处一行。 */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-subtle">
        {/* 宿主机本地开发读的是内存演示种子（真实日志由服务端的日志片提供），明示出来。 */}
        {isDockerRuntime() ? null : (
          <span role="status" className="text-sm text-fg-muted">
            演示数据
          </span>
        )}
        <span>{logRetentionText('runtime')}</span>
        {notices.length > 0 ? <span className="text-fg-muted">{notices.join('；')}</span> : null}
      </div>

      {storage.failedWrites > 0 ? (
        <p
          role="alert"
          className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
        >
          {`有 ${storage.failedWrites} 条运行日志未能写入磁盘（服务端写盘失败）。`}
        </p>
      ) : null}

      {table}

      {truncated ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-xs text-fg-muted">还有更早的记录</p>
          <button
            type="button"
            disabled={loadingOlder}
            onClick={() => void loadOlder(gateway)}
            className="rounded-lg border border-control-line bg-surface-raised px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:border-fg-subtle disabled:opacity-50"
          >
            {loadingOlder ? '加载中…' : '加载更早的记录'}
          </button>
          {olderError ? (
            <p role="status" className="text-xs text-danger">
              更早的记录加载失败
            </p>
          ) : null}
        </div>
      ) : olderError ? (
        <p role="status" className="text-xs text-danger">
          更早的记录加载失败
        </p>
      ) : null}

      <Dialog.Root open={fullscreen} onOpenChange={setFullscreen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-overlay-strong" />
          <Dialog.Content
            aria-describedby={undefined}
            className="fixed inset-0 z-[55] flex flex-col gap-3 bg-bg p-4"
          >
            <div className="flex items-center justify-between">
              <Dialog.Title className="text-sm font-medium text-fg">平台运行日志（全屏）</Dialog.Title>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="rounded-lg border border-line px-2 py-1 text-xs text-fg-muted transition-colors hover:text-fg"
                >
                  退出全屏
                </button>
              </Dialog.Close>
            </div>
            {/* 全屏容器里不给 min-h：矮视口下表格自己滚动，不撑破弹窗。 */}
            <LogTable
              label="运行日志表"
              minWidthClass={TABLE_MIN_WIDTH_CLASS}
              columns={RUNTIME_LOG_COLUMNS}
              rows={entries}
              rowKey={(entry) => entry.id}
              emptyMessage={emptyMessage}
              shellClassName="min-h-0 flex-1 overflow-hidden panel-surface"
              busy={querying}
            />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <ClearLogsDialog />
    </div>
  )
}
