import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { FILE_KIND_LABELS } from '@elysian/contracts'
import type { FileEntry } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { formatDateTime } from '../../components/format'
import { ArrowUpFromLine, File, Folder, Loader2 } from '../../components/icons'
import { EmptyState, ErrorState, LoadingState } from '../../components/states/StateViews'
import { useFilesStore } from '../../stores/filesStore'
import { joinFilesPath, normalizeFilesPath, parentFilesPath } from './filesPath'
import { formatEntrySize, orderFileEntries } from './filesListing'
import { FileRowMenu } from './FileRowMenu'
import { RenameDialog } from './RenameDialog'

/** 「上一级」等主要按钮的通用样式：中性描边，动作写进文字。 */
const TOOLBAR_ACTION_CLASS =
  'inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface-raised px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:border-fg-subtle disabled:cursor-not-allowed disabled:opacity-50'

/**
 * 文件管理页：目录内容以系统文件管理器的详细列表呈现。
 * 当前目录的真源是路由（files/*），进入与返回都走导航；行内单击选中、双击进入目录，
 * 键盘等价（上下箭头移动、回车进入）始终可用——双击不能是唯一入口。
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
  const load = useFilesStore((s) => s.load)
  const paste = useFilesStore((s) => s.paste)

  useEffect(() => {
    void load(gateway, path)
  }, [gateway, load, path])

  // 根目录落在 /files 本身，避免 /files/ 的尾巴被拼进路径。
  const go = (next: string) => navigate(next === '/' ? '/files' : `/files${next}`)

  const directoryCount = entries.filter((entry) => entry.kind === 'directory').length

  return (
    <section aria-label="文件管理">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
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
        </div>
        {status === 'ready' ? (
          <p className="text-xs tabular-nums text-fg-muted">
            共 {directoryCount} 个文件夹 · {entries.length - directoryCount} 个文件
          </p>
        ) : null}
      </div>

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
        <FileTable key={path} entries={entries} path={path} onOpen={go} />
      )}
    </section>
  )
}

function FileTable({
  entries,
  path,
  onOpen,
}: {
  entries: readonly FileEntry[]
  path: string
  onOpen(path: string): void
}) {
  const ordered = useMemo(() => orderFileEntries(entries), [entries])
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ entry: FileEntry; path: string } | null>(null)
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
      className="overflow-x-auto rounded-xl border border-line bg-surface"
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
                onRename={(renameEntry, renamePath) => setRenaming({ entry: renameEntry, path: renamePath })}
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
      {renaming ? (
        <RenameDialog entry={renaming.entry} entryPath={renaming.path} onClose={() => setRenaming(null)} />
      ) : null}
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
      className="text-accent underline-offset-2 transition-colors hover:underline"
    >
      计算
    </button>
  )
}
