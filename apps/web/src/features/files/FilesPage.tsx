import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router'
import { FILE_KIND_LABELS } from '@elysian/contracts'
import type { FileEntry, FileSearchResult } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { formatDateTime } from '../../components/format'
import { ArrowUpFromLine, File, Folder, Loader2 } from '../../components/icons'
import { DataTable, type DataTableColumn } from '../../components/DataTable'
import { EmptyState, ErrorState, LoadingState } from '../../components/states/StateViews'
import { RefreshButton } from '../../components/RefreshState'
import { useFilesStore } from '../../stores/filesStore'
import { joinFilesPath, normalizeFilesPath, parentFilesPath } from './filesPath'
import { formatEntrySize, orderFileEntries } from './filesListing'
import { FileRowMenu } from './FileRowMenu'
import { FilesBackgroundMenu } from './FilesBackgroundMenu'
import { FileDownloadDialog, FileUploadDialog } from './FileTransferDialogs'
import { RenameDialog } from './RenameDialog'
import { PermissionDialog } from './PermissionDialog'
import { CTL_PRIMARY, CTL_TOOLBAR } from '../../components/formControl'
import { Button } from '../../components/Button'
import { IconButton } from '../../components/IconButton'
import './filesToolbar.css'

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
  const uploadFiles = useFilesStore((s) => s.uploadFiles)
  const downloadEntry = useFilesStore((s) => s.downloadEntry)
  const transferBusy = useFilesStore((s) => s.upload?.busy ?? false)
  const uploadInput = useRef<HTMLInputElement>(null)
  const uploadTarget = useRef(path)

  const [renaming, setRenaming] = useState<DialogTarget>(null)
  const [permitting, setPermitting] = useState<DialogTarget>(null)

  // FileRowMenu 的回调签名是 (entry, entryPath)，转成对话框挂起状态。
  const openRename = (entry: FileEntry, entryPath: string) => setRenaming({ entry, path: entryPath })
  const openPermission = (entry: FileEntry, entryPath: string) =>
    setPermitting({ entry, path: entryPath })
  const chooseUpload = (targetPath: string) => {
    if (transferBusy) return
    uploadTarget.current = targetPath
    uploadInput.current?.click()
  }
  const onUpload = (entry: FileEntry, entryPath: string) => chooseUpload(entry.kind === 'directory' ? entryPath : path)
  const onDownload = (entry: FileEntry, entryPath: string) => void downloadEntry(gateway, entryPath, entry)

  useEffect(() => {
    void load(gateway, path, { silent: true })
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

  const refreshButton = <RefreshButton className="dt-toolbar-control-icon" onPress={() => void load(gateway, path)} busy={reloading} />
  const parentButton = (
    <IconButton asChild label="上一级" tooltipSide="bottom">
      <Button variant="primary" type="button" aria-label="上一级" onClick={() => go(parentFilesPath(path))}
        disabled={path === '/'} className="files-parent-button shrink-0 whitespace-nowrap">
        <ArrowUpFromLine aria-hidden size={16} />
        <span className="files-parent-label">上一级</span>
      </Button>
    </IconButton>
  )

  return (
    <section aria-label="文件管理">
      {(clipboard || status !== 'ready') && (
        <div className={`${CTL_TOOLBAR} mb-4 flex items-center gap-2`}>
          {clipboard ? (
            <Button variant="primary"
              type="button"
              onClick={() => void paste(gateway, path)}
              title={`粘贴 ${clipboard.path}${clipboard.intent === 'move' ? '（移动）' : ''}`}
              className={CTL_PRIMARY}
            >
              粘贴
            </Button>
          ) : null}
          {status !== 'ready' && <>{refreshButton}{parentButton}</>}
        </div>
      )}
      <input
        ref={uploadInput}
        type="file"
        multiple
        hidden
        aria-label="选择上传文件"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? [])
          event.currentTarget.value = ''
          if (files.length) void uploadFiles(gateway, uploadTarget.current, files)
        }}
      />
      {status === 'ready' && errorMessage ? <p role="alert" className="mb-3 text-xs text-danger">刷新失败：{errorMessage}。已保留上次读取结果。<Button variant="link" type="button" className="ml-2 underline" onClick={() => void load(gateway, path)}>重试</Button></p> : null}
      <FilesBackgroundMenu onUpload={() => chooseUpload(path)} disabled={status !== 'ready' || transferBusy}>
        {status === 'loading' || status === 'idle' ? (
          <LoadingState label="正在读取目录内容…" />
        ) : status === 'error' ? (
          <ErrorState
            title="目录读取失败"
            description={errorMessage}
            action={
              <Button variant="primary" type="button" onClick={() => go('/')} className={CTL_PRIMARY}>
                返回根目录
              </Button>
            }
          />
        ) : (
          <FileTable
            entries={entries}
            results={searchResults}
            path={path}
            keyword={searchKeyword}
            searching={searching}
            reloading={reloading}
            searchAction={refreshButton}
            toolbar={parentButton}
            onSearch={(keyword) => void search(gateway, keyword)}
            onOpen={go}
            onRename={openRename}
            onPermission={openPermission}
            onDownload={onDownload}
            onUpload={onUpload}
            transferBusy={transferBusy}
          />
        )}
      </FilesBackgroundMenu>
      <FileDownloadDialog />
      <FileUploadDialog />
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

/** 目录与全树搜索共用常驻外壳；输入与表头不会因搜索结果更新而卸载。 */
type FileTableRow = FileEntry | FileSearchResult

function FileTable({
  entries,
  results,
  path,
  keyword,
  searching,
  reloading,
  searchAction,
  toolbar,
  onSearch,
  onOpen,
  onRename,
  onPermission,
  onDownload,
  onUpload,
  transferBusy,
}: {
  entries: readonly FileEntry[]
  results: readonly FileSearchResult[]
  path: string
  keyword: string
  searching: boolean
  reloading: boolean
  searchAction: ReactNode
  toolbar: ReactNode
  onSearch(keyword: string): void
  onOpen(path: string): void
  onRename(entry: FileEntry, entryPath: string): void
  onPermission(entry: FileEntry, entryPath: string): void
  onDownload(entry: FileEntry, entryPath: string): void
  onUpload(entry: FileEntry, entryPath: string): void
  transferBusy: boolean
}) {
  const gateway = useGateway()
  const isSearching = keyword.trim().length > 0
  const [focusedPath, setFocusedPath] = useState<string | null>(null)
  const [selected, setSelected] = useState<(string | number)[]>([])
  const sizes = useFilesStore((state) => state.sizes)
  const computingPaths = useFilesStore((state) => state.computingPaths)
  const computeSizes = useFilesStore((state) => state.computeSizes)
  const rows = useMemo<readonly FileTableRow[]>(
    () => isSearching ? (searching ? [] : results) : orderFileEntries(entries),
    [entries, results, isSearching, searching],
  )
  const rowPath = (entry: FileTableRow) => 'path' in entry ? entry.path : joinFilesPath(path, entry.name)
  const selectionKey = `${path}\0${keyword}`
  const selectionScope = useRef({ key: selectionKey })
  if (selectionScope.current.key !== selectionKey) selectionScope.current = { key: selectionKey }

  useEffect(() => {
    setSelected([])
    setFocusedPath(null)
  }, [selectionKey])

  useEffect(() => {
    if (searching) return
    const ids = new Set(rows.map((entry) => 'path' in entry ? entry.path : joinFilesPath(path, entry.name)))
    setSelected((previous) => previous.every((id) => ids.has(String(id)))
      ? previous
      : previous.filter((id) => ids.has(String(id))))
    setFocusedPath((previous) => previous && ids.has(previous) ? previous : null)
  }, [rows, path, searching])

  const open = (entry: FileTableRow) => {
    const entryPath = rowPath(entry)
    if (isSearching) onOpen(entry.kind === 'directory' ? entryPath : parentFilesPath(entryPath))
    else if (entry.kind === 'directory') onOpen(entryPath)
  }
  const selectedIds = new Set(selected)
  const pendingSizes = new Set(computingPaths)
  const sizeTargets = rows.flatMap((entry) => {
    const id = rowPath(entry)
    return entry.kind === 'directory' && selectedIds.has(id) && sizes[id] === undefined && !pendingSizes.has(id) ? [id] : []
  })
  const calculateSelected = async () => {
    const scope = selectionScope.current
    const succeeded = new Set(await computeSizes(gateway, sizeTargets))
    if (scope === selectionScope.current && succeeded.size) {
      setSelected((previous) => previous.filter((id) => !succeeded.has(String(id))))
    }
  }
  const columns: DataTableColumn<FileTableRow>[] = [
    {
      key: 'name',
      header: '名称',
      primary: true,
      width: isSearching ? 'minmax(0,1.5fr)' : 'minmax(0,1.8fr)',
      accessor: (entry) => entry.name,
      cell: (entry) => (
        <span className="flex min-w-0 items-center gap-2">
          {entry.kind === 'directory'
            ? <Folder aria-hidden size={15} className="shrink-0 text-fg-subtle" />
            : <File aria-hidden size={15} className="shrink-0 text-fg-subtle" />}
          <span className="truncate font-medium text-fg" title={entry.name}>{entry.name}</span>
        </span>
      ),
    },
    ...(isSearching ? [{
      key: 'location',
      header: '所在位置',
      width: 'minmax(0,2.1fr)',
      accessor: (entry: FileTableRow) => parentFilesPath(rowPath(entry)),
      cell: (entry: FileTableRow) => <span className="block truncate font-mono text-xs text-fg-muted" title={rowPath(entry)}>{parentFilesPath(rowPath(entry))}</span>,
    }] : [{
      key: 'modifiedAt',
      header: '修改时间',
      width: 'minmax(0,1.4fr)',
      accessor: (entry: FileTableRow) => new Date(entry.modifiedAt),
      cell: (entry: FileTableRow) => <time className="tabular-nums text-fg-muted" dateTime={entry.modifiedAt}>{formatDateTime(entry.modifiedAt)}</time>,
    }]),
    {
      key: 'kind',
      header: '类型',
      width: 'minmax(0,.7fr)',
      accessor: (entry) => FILE_KIND_LABELS[entry.kind],
      cell: (entry) => <span className="text-fg-muted">{FILE_KIND_LABELS[entry.kind]}</span>,
    },
    ...(!isSearching ? [{
      key: 'permission',
      header: '权限/所有者',
      width: 'minmax(0,1.2fr)',
      accessor: (entry: FileTableRow) => `${entry.mode}/${entry.owner}`,
      cell: (entry: FileTableRow) => <span className="tabular-nums text-fg-muted">{entry.mode}/{entry.owner}</span>,
    }] : []),
    {
      key: 'sizeBytes',
      header: '大小',
      width: 'minmax(0,.9fr)',
      accessor: (entry) => entry.sizeBytes ?? sizes[rowPath(entry)],
      cell: (entry) => entry.kind === 'directory'
        ? <DirectorySizeCell dirPath={rowPath(entry)} name={entry.name} />
        : <span className="tabular-nums text-fg-muted">{entry.sizeBytes === undefined ? '—' : formatEntrySize(entry.sizeBytes)}</span>,
    },
  ]

  return (
    <DataTable
      rows={rows}
      columns={columns}
      getRowId={rowPath}
      getRowLabel={(entry) => isSearching ? `${entry.name}（${rowPath(entry)}）` : entry.name}
      ariaLabel={isSearching ? '搜索结果' : '文件列表'}
      className="files-data-table dt-toolbar-inline-actions"
      searchAction={searchAction}
      toolbar={toolbar}
      query={keyword}
      onQueryChange={onSearch}
      filterMode="external"
      searchPlaceholder="搜索文件或目录"
      selected={selected}
      onSelectionChange={setSelected}
      selectionKey={selectionKey}
      busy={reloading || searching}
      bulkActions={() => (
        <Button unstyled type="button" className="dt-action dt-action-primary whitespace-nowrap"
          disabled={transferBusy || searching || reloading || !sizeTargets.length}
          onClick={() => void calculateSelected()}>
          计算目录大小
        </Button>
      )}
      emptyState={searching
        ? <LoadingState label="正在搜索…" />
        : isSearching
          ? <EmptyState title="没有找到匹配的条目" description={`可搜索的范围内没有名称或路径包含「${keyword.trim()}」的条目，换个关键词试试。`} />
          : <EmptyState title="此目录为空" description="这个目录下没有任何文件或子目录。" />}
      onRowClick={(entry) => setFocusedPath(rowPath(entry))}
      onRowFocus={(entry) => setFocusedPath(rowPath(entry))}
      onRowDoubleClick={open}
      onRowActivate={open}
      rowKeyboardNav
      highlighted={(entry) => focusedPath === rowPath(entry)}
      rowTitle={(entry) => isSearching
        ? entry.kind === 'directory' ? '双击进入目录' : '双击转到所在目录'
        : entry.kind === 'directory' ? '双击打开目录' : ''}
      rowWrapper={(entry, children) => (
        <FileRowMenu
          key={rowPath(entry)}
          entry={entry}
          entryPath={rowPath(entry)}
          onRename={onRename}
          onPermission={onPermission}
          onDownload={onDownload}
          onUpload={onUpload}
          transferBusy={transferBusy}
        >{children}</FileRowMenu>
      )}
    />
  )
}

/**
 * 目录的大小格：列举不给目录大小（累计求和代价大），默认只有「计算」按钮，
 * 点击后经 adapter 递归求和，等待期间转圈，结果按路径缓存、换目录回来仍在。
 */
function DirectorySizeCell({ dirPath, name }: { dirPath: string; name: string }) {
  const gateway = useGateway()
  const size = useFilesStore((s) => s.sizes[dirPath])
  const error = useFilesStore((s) => s.sizeErrors[dirPath])
  const computing = useFilesStore((s) => s.computingPaths.includes(dirPath))
  const computeSizes = useFilesStore((s) => s.computeSizes)

  if (computing) {
    return (
      <span className="inline-flex items-center gap-1.5 text-fg-muted">
        <Loader2 aria-hidden size={13} className="shrink-0 animate-spin motion-reduce:animate-none" />
        计算中
      </span>
    )
  }
  if (size !== undefined) return <span className="tabular-nums text-fg-muted">{formatEntrySize(size)}</span>
  return (
    <Button variant="link"
      type="button"
      onClick={() => void computeSizes(gateway, [dirPath])}
      aria-label={error ? `重试计算 ${name} 的目录大小：${error}` : `计算 ${name} 的目录大小`}
      className="max-w-full whitespace-normal text-left underline-offset-2 transition-colors hover:underline"
    >
      {error ? <span className="text-danger">计算失败：{error}</span> : '计算'}
    </Button>
  )
}
