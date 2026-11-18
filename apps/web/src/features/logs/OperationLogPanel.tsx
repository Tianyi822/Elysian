import { useCallback } from 'react'
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
import { isDockerRuntime } from '../../utils/isDockerRuntime'
import { useGateway } from '../../adapters/GatewayProvider'
import { formatLoginTime } from '../../components/format'
import { GooeySelect } from '../../components/GooeySelect'
import { StatusTag } from '../../components/StatusTag'
import type { StatusTone } from '../../components/StatusTag'
import { ErrorState, LoadingState } from '../../components/states/StateViews'
import { useOperationLogStore } from '../../stores/operationLogStore'
import { useLogReportNotifications } from './useLogReportNotifications'
import { useDebouncedSearch } from './useDebouncedSearch'
import type {
  OperationLogCategoryFilter,
  OperationLogResultFilter,
} from '../../stores/operationLogStore'
import { LogMessageCell } from './LogMessageCell'
import { LogLoadOlder } from './LogLoadOlder'
import { LogTable } from './LogTable'
import type { LogColumn } from './LogTable'
import { Button } from '../../components/Button'
import './logFilters.css'

/**
 * 平台操作日志面板：服务端在写端点中间件与显式调用点采集的真实动作记录，
 * 界面只读（倒序条目 + 截断/坏行计数 + 存储统计），分类、结果与搜索走服务端筛选。
 *
 * 分类、结果通过搜索右侧的两个 EasyUI GooeyMenu 筛选；日志大小、总数与保留口径单独展示。
 *
 * 表格与运行日志**共用同一套底座**（`LogTable` + `LogMessageCell`）：固定列宽、
 * 表头 sticky、横向整表滚动、长文本省略加「查看完整内容」悬浮窗，两个面板因此
 * 不需要各自维护一套外观。列宽是可算的：日期时间列是固定 19 字符的等宽数字，
 * 其余每列按最长中文标签取整档，只有操作内容列吃掉剩余宽度。
 */

/** 结果 → 状态标签色调：失败取危险色；文字由契约标签表给出，颜色只是辅助。 */
export function outcomeTone(result: OperationLogOutcome): StatusTone {
  return result === 'success' ? 'success' : 'danger'
}

/** 操作内容单元格的文本：动作短语加参数摘要（没有摘要时只有动作短语）。 */
export function operationLogContent(entry: OperationLogEntry): string {
  return entry.summary ? `${entry.action} · ${entry.summary}` : entry.action
}

/**
 * 筛选后没有命中的表格内提示。数据库槽位有专门解释：契约里的分类固定渲染，
 * 没有记录时给出说明，空着是设计而非缺陷。
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

const COLUMNS: readonly LogColumn<OperationLogEntry>[] = [
  { key: 'at', header: '日期时间', width: '176px', accessor: entry => new Date(entry.at), cell: entry => <span className="tabular-nums text-fg-muted">{formatLoginTime(entry.at)}</span> },
  { key: 'category', header: '分类', width: '112px', accessor: entry => OPERATION_LOG_CATEGORY_LABELS[entry.category], cell: entry => <StatusTag label={OPERATION_LOG_CATEGORY_LABELS[entry.category]} /> },
  { key: 'target', header: '操作对象', width: 'minmax(120px,1fr)', accessor: entry => entry.target, cell: entry => <span className="block truncate text-fg-muted">{entry.target ?? '—'}</span> },
  { key: 'content', header: '操作内容', primary: true, width: 'minmax(240px,2fr)', accessor: operationLogContent, cell: entry => <LogMessageCell text={operationLogContent(entry)} details={<OperationDetails entry={entry} />} /> },
  { key: 'result', header: '结果', width: '96px', accessor: entry => OPERATION_LOG_OUTCOME_LABELS[entry.result], cell: entry => <StatusTag label={OPERATION_LOG_OUTCOME_LABELS[entry.result]} tone={outcomeTone(entry.result)} /> },
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

  useLogReportNotifications('操作日志', { ready: status === 'ready', truncated, skippedLines, skippedFiles, olderError, failedWrites: storage?.failedWrites, trimmedBySize: storage?.trimmedBySize })

  const reloadSearch = useCallback(() => void load(gateway), [gateway, load])
  const trimmedSearch = useDebouncedSearch(search, reloadSearch, `${categoryFilter}:${resultFilter}`)

  if (status === 'loading' || status === 'idle') {
    return <LoadingState label="正在加载操作日志…" />
  }

  if (status === 'error' || !storage) {
    return (
      <ErrorState title="操作日志加载失败" description={errorMessage} onRetry={() => void load(gateway)} />
    )
  }

  const querying = refreshing && !loadingOlder

  return (
    <div className="flex h-full flex-col">
      {errorMessage ? <p role="alert" className="text-xs text-danger">刷新失败：{errorMessage}。已保留上次读取结果。<Button variant="link" type="button" className="ml-2 underline" onClick={() => void load(gateway)}>重试</Button></p> : null}
      {/* 关于数据来源与保留口径的事实说明，与控件分行：演示态在宿主机本地开发才出现。 */}
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-subtle">
        {/* 容器内条目来自服务端真实采集（客户端无法投稿），宿主机本地开发是内存演示，明示出来。 */}
        {isDockerRuntime() ? null : (
          <span role="status" className="text-sm text-fg-muted">
            演示数据
          </span>
        )}
        <span>
          日志大小：<span className="tabular-nums text-fg">{formatLogBytes(storage.totalBytes)}</span>
        </span>
        <span>
          共 <span className="tabular-nums text-fg">{total}</span> 条操作记录
        </span>
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
        columns={COLUMNS}
        rows={entries}
        rowKey={(entry) => entry.id}
        emptyMessage={total === 0 && categoryFilter === 'all' && resultFilter === 'all' && !trimmedSearch
          ? <><span className="block font-medium text-fg">还没有操作日志</span><span className="mt-2 block">通过面板按钮改动系统或数据库的动作都会记录在这里。</span></>
          : filteredEmptyText(categoryFilter, trimmedSearch.length > 0)}
        busy={querying} query={search} onQueryChange={setSearch}
        selectionKey={`${categoryFilter}:${resultFilter}`}
        className="log-filter-table"
        toolbar={(
          <div role="group" aria-label="操作日志筛选" className="flex items-center gap-2">
            <GooeySelect ariaLabel="操作分类筛选" fieldLabel="分类" items={CATEGORY_ITEMS}
              value={categoryFilter} onSelect={setCategoryFilter} className="operation-log-filter operation-log-category" />
            <GooeySelect ariaLabel="操作结果筛选" fieldLabel="结果" items={OUTCOME_ITEMS}
              value={resultFilter} onSelect={setResultFilter} className="operation-log-filter operation-log-outcome" />
          </div>
        )}
      />

      <LogLoadOlder className="mt-3" hasMore={truncated} busy={loadingOlder} error={olderError} onLoad={() => void loadOlder(gateway)} />
    </div>
  )
}
