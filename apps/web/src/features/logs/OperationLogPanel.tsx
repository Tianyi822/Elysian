import { useEffect, useRef } from 'react'
import {
  LOG_ENTRY_FETCH_LIMIT,
  OPERATION_LOG_CATEGORIES,
  OPERATION_LOG_CATEGORY_LABELS,
  OPERATION_LOG_OUTCOMES,
  OPERATION_LOG_OUTCOME_LABELS,
  formatLogBytes,
  logRetentionText,
} from '@elysian/contracts'
import type { OperationLogEntry, OperationLogOutcome } from '@elysian/contracts'
import { isDockerRuntime } from '../../app/runtime/isDockerRuntime'
import { useGateway } from '../../adapters/GatewayProvider'
import { formatLoginTime } from '../../components/format'
import { CTL_FIELD, CTL_TOOLBAR } from '../../components/formControl'
import { Search } from '../../components/icons'
import { SelectDropdown } from '../../components/SelectDropdown'
import { StatusTag } from '../../components/StatusTag'
import type { StatusTone } from '../../components/StatusTag'
import { EmptyState, ErrorState, LoadingState } from '../../components/states/StateViews'
import { useOperationLogStore } from '../../stores/operationLogStore'
import type {
  OperationLogCategoryFilter,
  OperationLogResultFilter,
} from '../../stores/operationLogStore'
import { LogMessageCell } from './LogMessageCell'
import { LogTable } from './LogTable'
import type { LogColumn } from './LogTable'

/**
 * 平台操作日志面板：服务端在写端点中间件与显式调用点采集的真实动作记录，
 * 界面只读（倒序条目 + 截断/坏行计数 + 存储统计），分类、结果与搜索走服务端筛选。
 *
 * 筛选走两个自绘下拉（分类、结果）而不是六枚 chip 加三枚 chip 平铺：chip 一多，
 * 两组「全部」并排出现就再也读不出哪个管分类、哪个管结果。下拉的触发器带字段名前缀，
 * 筛选生效时触发器进入 accent 态。工具栏只留控件与计数，保留口径与演示态说明放下方一行。
 *
 * 表格与运行日志**共用同一套底座**（`LogTable` + `LogMessageCell`）：固定列宽、
 * 表头 sticky、横向整表滚动、长文本省略加「查看完整内容」悬浮窗，两个面板因此
 * 不需要各自维护一套外观。列宽是可算的：日期时间列是固定 19 字符的等宽数字，
 * 其余每列按最长中文标签取整档，只有操作内容列吃掉剩余宽度。
 */

/** 固定列的宽度（px）：日期时间 w-44、分类 w-28、操作对象 w-40、结果 w-24。 */
export const OPERATION_LOG_COLUMN_PX = {
  time: 176,
  category: 112,
  target: 160,
  result: 96,
} as const

/** 操作内容列的最小宽度（px）：约 32 个中文字符，「改了什么」要一眼看得出。 */
export const OPERATION_LOG_CONTENT_MIN_PX = 480

/** 表格最小宽度 = 五列之和；窄于它的视口整表横向滚动，不压缩列。 */
export const OPERATION_LOG_TABLE_MIN_PX =
  OPERATION_LOG_COLUMN_PX.time +
  OPERATION_LOG_COLUMN_PX.category +
  OPERATION_LOG_COLUMN_PX.target +
  OPERATION_LOG_CONTENT_MIN_PX +
  OPERATION_LOG_COLUMN_PX.result

/** `OPERATION_LOG_TABLE_MIN_PX` 的 Tailwind 写法；改列宽时两处一起改（测试断言两者相等）。 */
export const OPERATION_LOG_TABLE_MIN_WIDTH_CLASS = 'min-w-[1024px]'

/** 结果 → 状态标签色调：失败取危险色；文字由契约标签表给出，颜色只是辅助。 */
export function outcomeTone(result: OperationLogOutcome): StatusTone {
  return result === 'success' ? 'success' : 'danger'
}

/** 操作内容单元格的文本：动作短语加参数摘要（没有摘要时只有动作短语）。 */
export function operationLogContent(entry: OperationLogEntry): string {
  return entry.summary ? `${entry.action} · ${entry.summary}` : entry.action
}

/**
 * 搜索口径：匹配 action、summary 与 target，大小写不敏感；空关键词不过滤。
 * 时间与分类各自有列与筛选项，不参与关键词匹配。
 */
export function matchesOperationSearch(entry: OperationLogEntry, keyword: string): boolean {
  if (!keyword) return true
  const needle = keyword.toLowerCase()
  return (
    entry.action.toLowerCase().includes(needle) ||
    entry.summary.toLowerCase().includes(needle) ||
    (entry.target?.toLowerCase().includes(needle) ?? false)
  )
}

/**
 * 筛选后没有命中的表格内提示。数据库槽位有专门解释：契约里的五个分类固定渲染，
 * 而本期数据库域全是演示、演示动作不写进审计（规格 10.5），空着是设计而非缺陷。
 */
export function filteredEmptyText(
  categoryFilter: OperationLogCategoryFilter,
  hasKeyword: boolean,
): string {
  if (categoryFilter === 'database' && !hasKeyword) {
    return '还没有数据库类操作记录；通过面板按钮改动数据库的动作会记录在这里。'
  }
  return '没有匹配的操作记录，换个关键词或清空筛选'
}

/** 分类下拉候选：首项「全部」是不筛选，其余取自契约的分类词典。 */
const CATEGORY_ITEMS: readonly { value: OperationLogCategoryFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  ...OPERATION_LOG_CATEGORIES.map((category) => ({
    value: category,
    label: OPERATION_LOG_CATEGORY_LABELS[category],
  })),
]

/** 结果下拉候选：成功与失败两档加「全部」。 */
const OUTCOME_ITEMS: readonly { value: OperationLogResultFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  ...OPERATION_LOG_OUTCOMES.map((outcome) => ({
    value: outcome,
    label: OPERATION_LOG_OUTCOME_LABELS[outcome],
  })),
]

/** 悬浮窗里的一行元信息：字段名次要文字、取值正文色；长取值换行而不省略（悬浮窗的意义就是看全）。 */
function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-fg-muted">{label}</dt>
      <dd className="min-w-0 break-all text-fg">{value}</dd>
    </div>
  )
}

/**
 * 悬浮窗里的完整记录：时间、分类、结果，以及请求侧的三个字段。
 * 只列记录里确实有的字段——`target`、`method`、`path`、`httpStatus` 都可能为空。
 */
function OperationDetails({ entry }: { entry: OperationLogEntry }) {
  return (
    <dl className="mt-2 grid grid-cols-1 gap-y-1 border-t border-line pt-2 text-fg-muted sm:grid-cols-2 sm:gap-x-4">
      <MetaItem label="时间" value={formatLoginTime(entry.at)} />
      <MetaItem label="分类" value={OPERATION_LOG_CATEGORY_LABELS[entry.category]} />
      <MetaItem label="结果" value={OPERATION_LOG_OUTCOME_LABELS[entry.result]} />
      {entry.target ? <MetaItem label="对象" value={entry.target} /> : null}
      {entry.method ? <MetaItem label="方法" value={entry.method} /> : null}
      {entry.path ? <MetaItem label="路径" value={entry.path} /> : null}
      {entry.httpStatus === null ? null : (
        <MetaItem label="HTTP 状态" value={String(entry.httpStatus)} />
      )}
    </dl>
  )
}

/** 单元格的公共外框：行底分割线加内距，四个字以内的短内容列都用它。 */
const CELL_CLASS = 'border-b border-line px-3 py-2.5'

const COLUMNS: readonly LogColumn<OperationLogEntry>[] = [
  {
    label: '日期时间',
    widthClass: 'w-44',
    cell: (entry) => (
      <td className={`${CELL_CLASS} tabular-nums text-fg-muted`}>{formatLoginTime(entry.at)}</td>
    ),
  },
  {
    label: '分类',
    widthClass: 'w-28',
    cell: (entry) => (
      <td className={CELL_CLASS}>
        <StatusTag label={OPERATION_LOG_CATEGORY_LABELS[entry.category]} />
      </td>
    ),
  },
  {
    label: '操作对象',
    widthClass: 'w-40',
    cell: (entry) => (
      // 没有对象时给破折号，不省略整列——空单元格会被读成「渲染漏了」。
      <td className={`${CELL_CLASS} text-fg-muted`}>
        <span className="block truncate">{entry.target ?? '—'}</span>
      </td>
    ),
  },
  {
    // 不设宽度：这一列吃掉剩余，表格的 min-width 给它兜住 480px 的下限。
    label: '操作内容',
    cell: (entry) => (
      <LogMessageCell
        text={operationLogContent(entry)}
        details={<OperationDetails entry={entry} />}
      />
    ),
  },
  {
    label: '结果',
    widthClass: 'w-24',
    cell: (entry) => (
      <td className={CELL_CLASS}>
        <StatusTag
          label={OPERATION_LOG_OUTCOME_LABELS[entry.result]}
          tone={outcomeTone(entry.result)}
        />
      </td>
    ),
  },
]

export function OperationLogPanel() {
  const gateway = useGateway()
  const status = useOperationLogStore((s) => s.status)
  const errorMessage = useOperationLogStore((s) => s.errorMessage)
  const entries = useOperationLogStore((s) => s.entries)
  const total = useOperationLogStore((s) => s.total)
  const truncated = useOperationLogStore((s) => s.truncated)
  const skippedLines = useOperationLogStore((s) => s.skippedLines)
  const skippedFiles = useOperationLogStore((s) => s.skippedFiles)
  const storage = useOperationLogStore((s) => s.storage)
  const categoryFilter = useOperationLogStore((s) => s.categoryFilter)
  const resultFilter = useOperationLogStore((s) => s.resultFilter)
  const search = useOperationLogStore((s) => s.search)
  const refreshing = useOperationLogStore((s) => s.refreshing)
  const loadingOlder = useOperationLogStore((s) => s.loadingOlder)
  const olderError = useOperationLogStore((s) => s.olderError)
  const load = useOperationLogStore((s) => s.load)
  const loadOlder = useOperationLogStore((s) => s.loadOlder)
  const setCategoryFilter = useOperationLogStore((s) => s.setCategoryFilter)
  const setResultFilter = useOperationLogStore((s) => s.setResultFilter)
  const setSearch = useOperationLogStore((s) => s.setSearch)

  const committedSearchRef = useRef(search.trim())
  const trimmedSearch = search.trim()

  useEffect(() => {
    const delay = trimmedSearch === committedSearchRef.current ? 0 : 300
    const handle = setTimeout(() => {
      committedSearchRef.current = trimmedSearch
      void load(gateway)
    }, delay)
    return () => clearTimeout(handle)
  }, [gateway, load, categoryFilter, resultFilter, trimmedSearch])

  if (status === 'loading' || status === 'idle') {
    return <LoadingState label="正在加载操作日志…" />
  }

  if (status === 'error' || !storage) {
    return (
      <ErrorState title="操作日志加载失败" description={errorMessage} onRetry={() => void load(gateway)} />
    )
  }

  const filtersClear =
    categoryFilter === 'all' && resultFilter === 'all' && trimmedSearch.length === 0

  // 一条记录都没有：先讲清楚这个页签是干什么的，不摆空表。
  if (total === 0 && filtersClear) {
    return (
      <EmptyState
        title="还没有操作日志"
        description="通过面板按钮改动系统或数据库的动作都会记录在这里。"
      />
    )
  }

  const querying = refreshing && !loadingOlder

  return (
    <div className="flex h-full flex-col">
      {/*
        工具栏三块：筛选下拉 / 搜索 / 计数。窄屏（md 以下）一块一行，md 起回到一行三段、
        计数靠右。自由折行会把计数文字和控件混成一团，正是原来难以扫读的原因。
      */}
      <div className={`${CTL_TOOLBAR} mb-4 flex flex-col gap-2 panel-surface px-4 py-3 md:flex-row md:items-center`}>
        <div role="group" aria-label="操作日志筛选" className="flex flex-wrap items-center gap-2">
          <SelectDropdown
            ariaLabel="操作分类筛选"
            label="分类"
            active={categoryFilter !== 'all'}
            items={CATEGORY_ITEMS}
            value={categoryFilter}
            onSelect={setCategoryFilter}
          />
          <SelectDropdown
            ariaLabel="操作结果筛选"
            label="结果"
            active={resultFilter !== 'all'}
            items={OUTCOME_ITEMS}
            value={resultFilter}
            onSelect={setResultFilter}
          />
        </div>
        <div className="relative w-full md:max-w-md md:flex-1">
          <label htmlFor="operation-log-search" className="sr-only">
            搜索操作日志
          </label>
          <input
            id="operation-log-search"
            aria-label="搜索操作日志"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="请输入搜索关键字"
            className={`${CTL_FIELD} pl-8`}
          />
          <Search
            aria-hidden
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle"
          />
        </div>
        <div className="flex items-center justify-between gap-3 text-xs text-fg-muted md:ml-auto">
          <span>
            日志大小：
            <span className="tabular-nums text-fg">{formatLogBytes(storage.totalBytes)}</span>
          </span>
          <span>
            共 <span className="tabular-nums text-fg">{total}</span> 条操作记录
          </span>
        </div>
      </div>

      {/* 关于数据来源与保留口径的事实说明，与控件分行：演示态在宿主机本地开发才出现。 */}
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-subtle">
        {/* 容器内条目来自服务端真实采集（客户端无法投稿），宿主机本地开发是内存演示，明示出来。 */}
        {isDockerRuntime() ? null : (
          <span role="status" className="text-sm text-fg-muted">
            演示数据
          </span>
        )}
        <span>{logRetentionText('operation')}</span>
      </div>

      {/* 审计缺口先于列表说明：写盘失败时条目本身就不完整，这条不能藏在别处。 */}
      {storage.failedWrites > 0 ? (
        <div
          role="status"
          className="mb-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger"
        >
          有 <span className="tabular-nums">{storage.failedWrites}</span> 条操作未能写入审计日志（服务端写盘失败）
        </div>
      ) : null}

      {/* 列表完整性的三个数字与保留口径说明：都只在非零时出现，不为「正常」留一行字。 */}
      {truncated || skippedLines > 0 || skippedFiles > 0 || storage.trimmedBySize ? (
        <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted">
          {truncated ? <span>仅显示最近 {LOG_ENTRY_FETCH_LIMIT} 条</span> : null}
          {skippedLines > 0 ? (
            <span>
              有 <span className="tabular-nums">{skippedLines}</span> 行无法解析，已跳过
            </span>
          ) : null}
          {skippedFiles > 0 ? (
            <span>
              有 <span className="tabular-nums">{skippedFiles}</span> 个日志文件读取失败，已跳过
            </span>
          ) : null}
          {storage.trimmedBySize ? <span>日志已超出量上限，较早的记录被自动清理</span> : null}
        </div>
      ) : null}

      <LogTable
        label="操作日志表"
        minWidthClass={OPERATION_LOG_TABLE_MIN_WIDTH_CLASS}
        columns={COLUMNS}
        rows={entries}
        rowKey={(entry) => entry.id}
        emptyMessage={filteredEmptyText(categoryFilter, trimmedSearch.length > 0)}
        busy={querying}
      />

      {truncated ? (
        <div className="mt-3 flex flex-col items-start gap-2">
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
        <p role="status" className="mt-3 text-xs text-danger">
          更早的记录加载失败
        </p>
      ) : null}
    </div>
  )
}
