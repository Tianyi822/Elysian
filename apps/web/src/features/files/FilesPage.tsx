import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { FILE_KIND_LABELS } from '@elysian/contracts'
import type { FileEntry, FileSearchResult } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { formatDateTime } from '../../components/format'
import { ArrowUpFromLine, File, Folder, Loader2, Search } from '../../components/icons'
import { EmptyState, ErrorState, LoadingState } from '../../components/states/StateViews'
import { BusyVeil, RefreshButton } from '../../components/RefreshState'
import { useFilesStore } from '../../stores/filesStore'
import { joinFilesPath, normalizeFilesPath, parentFilesPath } from './filesPath'
import { formatEntrySize, orderFileEntries } from './filesListing'
import { FileRowMenu } from './FileRowMenu'
import { RenameDialog } from './RenameDialog'
import { PermissionDialog } from './PermissionDialog'
import { CTL_FIELD, CTL_PRIMARY, CTL_TOOLBAR } from '../../components/formControl'

/** 「上一级」等主要按钮：形状与色阶全部走控件层。 */
const TOOLBAR_ACTION_CLASS = CTL_PRIMARY

/** 重命名与权限对话框的挂起状态：两张表（目录列表与搜索结果）共用同一份。 */
type DialogTarget = { entry: FileEntry; path: string } | null

/**
 * 文件管理页：目录内容以系统文件管理器的详细列表呈现。
 * 当前目录的真源是路由（files/*），进入与返回都走导航；行内单击选中、双击进入目录，
 * 键盘等价（上下箭头移动、回车进入）始终可用——双击不能是唯一入口。
 * 搜索框输入即全树检索：结果可能来自任何目录，双击目录进入、文件跳到所在目录。
 */
export function FilesPage() {
  const gateway = useGateway()
  const navigate = useNavigate()
  const rawPath = useParams()['*'] ?? ''
  const path = normalizeFilesPath(rawPath)
  const status = useFilesStore((s) => s.status)
  const entries = useFilesStore((s) => s.entries)
  const errorMessage = useFilesStore((s) => s.errorMessage)
  const clipboard = useFilesStore((s) => s.clipboard)
  const searchKeyword = useFilesStore((s) => s.searchKeyword)
  const searchResults = useFilesStore((s) => s.searchResults)
  const searching = useFilesStore((s) => s.searching)
  const reloading = useFilesStore((s) => s.reloading)
  const load = useFilesStore((s) => s.load)
  const paste = useFilesStore((s) => s.paste)
  const search = useFilesStore((s) => s.search)
  const clearSearch = useFilesStore((s) => s.clearSearch)

  const [renaming, setRenaming] = useState<DialogTarget>(null)
  const [permitting, setPermitting] = useState<DialogTarget>(null)

  // FileRowMenu 的回调签名是 (entry, entryPath)，转成对话框挂起状态。
  const openRename = (entry: FileEntry, entryPath: string) => setRenaming({ entry, path: entryPath })
  const openPermission = (entry: FileEntry, entryPath: string) =>
    setPermitting({ entry, path: entryPath })

  useEffect(() => {
    void load(gateway, path)
  }, [gateway, load, path])

  // 根目录落在 /files 本身，避免 /files/ 的尾巴被拼进路径。
  // 导航即离开搜索态：进入某个结果或上一级后，回到目录列表。
  const go = (next: string) => {
    clearSearch()
    navigate(next === '/' ? '/files' : `/files${next}`)
  }

  // 从搜索结果里发起的重命名/压缩会改动条目本身：关闭对话框时按当前关键词重跑搜索，结果不再陈旧。
  const closeDialog = (setter: (target: DialogTarget) => void) => {
    setter(null)
    if (searchKeyword.trim()) void search(gateway, searchKeyword)
  }

  const isSearching = searchKeyword.trim().length > 0

  return (
    <section aria-label="文件管理">
      <div className={`${CTL_TOOLBAR} mb-4 flex flex-wrap items-center justify-between gap-3`}>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => go(parentFilesPath(path))}
            disabled={path === '/'}
            className={TOOLBAR_ACTION_CLASS}
          >
            <ArrowUpFromLine aria-hidden size={13} />
            上一级
          </button>
          {clipboard ? (
            <button
              type="button"
              onClick={() => void paste(gateway, path)}
              title={`粘贴 ${clipboard.path}${clipboard.intent === 'move' ? '（移动）' : ''}`}
              className={TOOLBAR_ACTION_CLASS}
            >
              粘贴
            </button>
          ) : null}
          <RefreshButton onPress={() => void load(gateway, path)} busy={reloading} formControl />
        </div>
        {status === 'ready' ? <FilesSearchBox onSearch={(keyword) => void search(gateway, keyword)} /> : null}
      </div>

      {isSearching ? (
        searching ? (
          <LoadingState label="正在搜索…" />
        ) : searchResults.length === 0 ? (
          <EmptyState
            title="没有找到匹配的条目"
            description={`可搜索的范围内没有名称或路径包含「${searchKeyword.trim()}」的条目，换个关键词试试。`}
          />
        ) : (
          <SearchResultsTable
            key={searchKeyword}
            results={searchResults}
            onOpen={go}
            onRename={openRename}
            onPermission={openPermission}
          />
        )
      ) : (
        <>
          {status === 'loading' || status === 'idle' ? (
            <LoadingState label="正在读取目录内容…" />
          ) : status === 'error' ? (
            <ErrorState
              title="目录读取失败"
              description={errorMessage}
              action={
                <button type="button" onClick={() => go('/')} className={TOOLBAR_ACTION_CLASS}>
                  返回根目录
                </button>
              }
            />
          ) : entries.length === 0 ? (
            <EmptyState title="此目录为空" description="这个目录下没有任何文件或子目录。" />
          ) : (
            /* 换目录即换表：选中态随目录清空，不把上一个目录的选中行带进新目录。 */
            <div className="busy-host">
              <BusyVeil busy={reloading} />
              <FileTable
                key={path}
                entries={entries}
                path={path}
                onOpen={go}
                onRename={openRename}
                onPermission={openPermission}
              />
            </div>
          )}
        </>
      )}

      {renaming ? (
        <RenameDialog
          entry={renaming.entry}
          entryPath={renaming.path}
          onClose={() => closeDialog(setRenaming)}
        />
      ) : null}
      {permitting ? (
        <PermissionDialog
          entry={permitting.entry}
          entryPath={permitting.path}
          onClose={() => closeDialog(setPermitting)}
        />
      ) : null}
    </section>
  )
}

/** 搜索框：占原计数位置；输入即全树检索，清空即回到目录列表。 */
function FilesSearchBox({ onSearch }: { onSearch(keyword: string): void }) {
  const keyword = useFilesStore((s) => s.searchKeyword)
  const resultCount = useFilesStore((s) => s.searchResults.length)
  const searching = useFilesStore((s) => s.searching)
  const inputId = useId()

  return (
    <div className="flex items-center gap-3">
      {keyword.trim() && !searching ? (
        <p className="text-xs tabular-nums text-fg-muted">{resultCount} 个匹配</p>
      ) : null}
      <div className="relative w-full sm:w-64">
        <Search
          aria-hidden
          className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle"
        />
        <label htmlFor={inputId} className="sr-only">
          搜索文件或目录
        </label>
        <input
          id={inputId}
          type="search"
          value={keyword}
          onChange={(event) => onSearch(event.target.value)}
          placeholder="搜索文件或目录"
          className={`${CTL_FIELD} pl-8`}
        />
      </div>
    </div>
  )
}

function FileTable({
  entries,
  path,
  onOpen,
  onRename,
  onPermission,
}: {
  entries: readonly FileEntry[]
  path: string
  onOpen(path: string): void
  onRename(entry: FileEntry, entryPath: string): void
  onPermission(entry: FileEntry, entryPath: string): void
}) {
  const ordered = useMemo(() => orderFileEntries(entries), [entries])
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>())

  const moveSelection = (fromName: string, delta: number) => {
    const index = ordered.findIndex((entry) => entry.name === fromName)
    const next = ordered[index + delta]
    if (!next) return
    setSelectedName(next.name)
    rowRefs.current.get(next.name)?.focus()
  }

  return (
    <div
      role="region"
      aria-label="文件列表"
      className="overflow-x-auto panel-surface"
    >
      {/* 46rem 是五列都不挤的下限：低于它整表横向滚动，名称列钉在左边陪滚。 */}
      <table className="w-full min-w-[46rem] table-fixed border-separate border-spacing-0 text-left text-sm">
        <colgroup>
          <col className="w-[32%]" />
          <col className="w-[22%]" />
          <col className="w-[12%]" />
          <col className="w-[20%]" />
          <col className="w-[14%]" />
        </colgroup>
        <thead>
          <tr>
            {['名称', '修改时间', '类型', '权限/所有者', '大小'].map((label, index) => (
              <th
                key={label}
                scope="col"
                className={`border-b border-line bg-surface px-3 py-2.5 text-xs font-medium text-fg-muted ${
                  index === 0 ? 'sticky left-0 z-20 border-r' : ''
                }`}
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ordered.map((entry, index) => {
            const selected = selectedName === entry.name
            const openable = entry.kind === 'directory'
            const entryPath = joinFilesPath(path, entry.name)
            return (
              <FileRowMenu
                key={entry.name}
                entry={entry}
                entryPath={entryPath}
                onRename={onRename}
                onPermission={onPermission}
              >
                <tr
                  ref={(element) => {
                    if (element) rowRefs.current.set(entry.name, element)
                    else rowRefs.current.delete(entry.name)
                  }}
                  tabIndex={selected || (selectedName === null && index === 0) ? 0 : -1}
                  aria-selected={selected}
                  onClick={() => setSelectedName(entry.name)}
                  onDoubleClick={() => openable && onOpen(entryPath)}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowDown') {
                      event.preventDefault()
                      moveSelection(entry.name, 1)
                    } else if (event.key === 'ArrowUp') {
                      event.preventDefault()
                      moveSelection(entry.name, -1)
                    } else if (event.key === 'Enter' && openable) {
                      onOpen(entryPath)
                    }
                  }}
                  title={openable ? '双击打开目录' : undefined}
                  className={`group whitespace-nowrap transition-colors hover:bg-surface-raised ${
                    selected ? 'bg-surface-raised' : ''
                  } ${openable ? 'cursor-pointer' : ''}`}
                >
                  <td
                    className={`sticky left-0 z-10 border-b border-r border-line px-3 py-2.5 font-medium group-hover:bg-surface-raised ${
                      selected ? 'bg-surface-raised' : 'bg-surface'
                    }`}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      {openable ? (
                        <Folder aria-hidden size={15} className="shrink-0 text-fg-subtle" />
                      ) : (
                        <File aria-hidden size={15} className="shrink-0 text-fg-subtle" />
                      )}
                      <span className="truncate font-medium text-fg" title={entry.name}>
                        {entry.name}
                      </span>
                    </span>
                  </td>
                  <td className="border-b border-line px-3 py-2.5 tabular-nums text-fg-muted">
                    <time dateTime={entry.modifiedAt}>{formatDateTime(entry.modifiedAt)}</time>
                  </td>
                  <td className="border-b border-line px-3 py-2.5 text-fg-muted">
                    {FILE_KIND_LABELS[entry.kind]}
                  </td>
                  <td className="border-b border-line px-3 py-2.5 tabular-nums text-fg-muted">
                    {entry.mode}/{entry.owner}
                  </td>
                  <td className="border-b border-line px-3 py-2.5 tabular-nums text-fg-muted">
                    {entry.kind === 'file' && entry.sizeBytes !== undefined ? (
                      formatEntrySize(entry.sizeBytes)
                    ) : (
                      <DirectorySizeCell dirPath={entryPath} name={entry.name} />
                    )}
                  </td>
                </tr>
              </FileRowMenu>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/**
 * 搜索结果表：全树匹配，结果可能来自任何目录，因此「所在位置」取代修改时间与权限列。
 * 双击目录进入该目录，双击文件跳到其父目录；右键菜单携带真实路径，操作照常可用。
 */
function SearchResultsTable({
  results,
  onOpen,
  onRename,
  onPermission,
}: {
  results: readonly FileSearchResult[]
  onOpen(path: string): void
  onRename(entry: FileEntry, entryPath: string): void
  onPermission(entry: FileEntry, entryPath: string): void
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null)

  const open = (result: FileSearchResult) =>
    onOpen(result.kind === 'directory' ? result.path : parentFilesPath(result.path))

  return (
    <div
      role="region"
      aria-label="搜索结果"
      className="overflow-x-auto panel-surface"
    >
      <table className="w-full min-w-[42rem] table-fixed border-separate border-spacing-0 text-left text-sm">
        <colgroup>
          <col className="w-[30%]" />
          <col className="w-[42%]" />
          <col className="w-[12%]" />
          <col className="w-[16%]" />
        </colgroup>
        <thead>
          <tr>
            {['名称', '所在位置', '类型', '大小'].map((label, index) => (
              <th
                key={label}
                scope="col"
                className={`border-b border-line bg-surface px-3 py-2.5 text-xs font-medium text-fg-muted ${
                  index === 0 ? 'sticky left-0 z-20 border-r' : ''
                }`}
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {results.map((result) => {
            const selected = selectedPath === result.path
            return (
              <FileRowMenu
                key={result.path}
                entry={result}
                entryPath={result.path}
                onRename={onRename}
                onPermission={onPermission}
              >
                <tr
                  tabIndex={0}
                  aria-selected={selected}
                  onClick={() => setSelectedPath(result.path)}
                  onDoubleClick={() => open(result)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') open(result)
                  }}
                  title={result.kind === 'directory' ? '双击进入目录' : '双击转到所在目录'}
                  className={`group cursor-pointer whitespace-nowrap transition-colors hover:bg-surface-raised ${
                    selected ? 'bg-surface-raised' : ''
                  }`}
                >
                  <td
                    className={`sticky left-0 z-10 border-b border-r border-line px-3 py-2.5 font-medium group-hover:bg-surface-raised ${
                      selected ? 'bg-surface-raised' : 'bg-surface'
                    }`}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      {result.kind === 'directory' ? (
                        <Folder aria-hidden size={15} className="shrink-0 text-fg-subtle" />
                      ) : (
                        <File aria-hidden size={15} className="shrink-0 text-fg-subtle" />
                      )}
                      <span className="truncate font-medium text-fg" title={result.name}>
                        {result.name}
                      </span>
                    </span>
                  </td>
                  <td className="border-b border-line px-3 py-2.5">
                    <span className="block truncate font-mono text-xs text-fg-muted" title={result.path}>
                      {parentFilesPath(result.path)}
                    </span>
                  </td>
                  <td className="border-b border-line px-3 py-2.5 text-fg-muted">
                    {FILE_KIND_LABELS[result.kind]}
                  </td>
                  <td className="border-b border-line px-3 py-2.5 tabular-nums text-fg-muted">
                    {result.kind === 'file' && result.sizeBytes !== undefined ? (
                      formatEntrySize(result.sizeBytes)
                    ) : (
                      <DirectorySizeCell dirPath={result.path} name={result.name} />
                    )}
                  </td>
                </tr>
              </FileRowMenu>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/**
 * 目录的大小格：列举不给目录大小（累计求和代价大），默认只有「计算」按钮，
 * 点击后经 adapter 递归求和，等待期间转圈，结果按路径缓存、换目录回来仍在。
 */
function DirectorySizeCell({ dirPath, name }: { dirPath: string; name: string }) {
  const gateway = useGateway()
  const size = useFilesStore((s) => s.sizes[dirPath])
  const computing = useFilesStore((s) => s.computingPaths.includes(dirPath))
  const computeSize = useFilesStore((s) => s.computeSize)

  if (computing) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <Loader2 aria-hidden size={13} className="animate-spin" />
        计算中
      </span>
    )
  }
  if (size !== undefined) return <>{formatEntrySize(size)}</>
  return (
    <button
      type="button"
      onClick={() => void computeSize(gateway, dirPath)}
      aria-label={`计算 ${name} 的目录大小`}
      className="text-accent-fg underline-offset-2 transition-colors hover:underline"
    >
      计算
    </button>
  )
}
