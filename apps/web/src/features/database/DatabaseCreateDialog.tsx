import * as Dialog from '@radix-ui/react-dialog'
import { useEffect, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import { File, Loader2, Upload, X } from '../../components/icons'
import { useGateway } from '../../adapters/GatewayProvider'
import { useDatabaseStore } from '../../stores/databaseStore'
import { isDockerRuntime } from '../../app/runtime/isDockerRuntime'
import { RealDatabaseCreateDialog } from './RealDatabaseCreateDialog'
import {
  SQLITE_FILE_SUFFIX,
  bytesToMb,
  databaseNameFromFile,
  emptyDraft,
  hasDatabaseCreateErrors,
  sqliteFilePath,
  toDatabaseCreateInput,
  validateDatabaseCreateDraft,
} from './databaseCreateForm'
import type { DatabaseCreateDraft, DatabaseCreateFormErrors, SqliteFileSource } from './databaseCreateForm'

const FIELD = 'w-full min-w-0 rounded-lg border border-line bg-surface-raised px-3 py-2 text-sm text-fg transition-colors placeholder:text-fg-subtle hover:border-fg-subtle'
const LABEL = 'mb-2 block text-xs font-medium leading-5 text-fg-muted'
const BUTTON = 'inline-flex min-h-9 items-center justify-center rounded-lg border border-line px-3 text-xs font-medium text-fg transition-colors hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-50'
const ERROR = 'mt-1 text-xs text-danger'

function SqliteFileField({
  draft, real, errors, showErrors, creating, onPickFile, onPatch,
}: {
  draft: DatabaseCreateDraft
  real: boolean
  errors: DatabaseCreateFormErrors
  showErrors: boolean
  creating: boolean
  onPickFile(file: File): void
  onPatch(part: Partial<DatabaseCreateDraft>): void
}) {
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragging(false)
    if (!creating && event.dataTransfer.files[0]) onPickFile(event.dataTransfer.files[0])
  }

  return <section aria-labelledby="db-create-source-label" className="mt-5 border-t border-line pt-5">
    <h3 id="db-create-source-label" className="mb-3 text-sm font-semibold text-fg">文件来源 <span className="text-danger">*</span></h3>
    <div role="group" aria-labelledby="db-create-source-label" className="grid w-full grid-cols-2 overflow-hidden rounded-lg border border-line">
      {(['upload', 'create'] as const).map((source: SqliteFileSource, index) => (
        <button key={source} type="button" disabled={creating} aria-pressed={draft.fileSource === source}
          onClick={() => onPatch({ fileSource: source })}
          className={'min-h-10 px-2 text-center text-xs transition-colors disabled:opacity-50 ' +
            (index > 0 ? 'border-l border-line ' : '') +
            (draft.fileSource === source ? 'bg-surface-raised font-medium text-fg' : 'text-fg-muted hover:bg-surface-raised hover:text-fg')}>
          {source === 'upload' ? real ? '上传 SQLite 文件' : '选择文件信息（演示）' : real ? '新建空数据库' : '模拟新建文件'}
        </button>
      ))}
    </div>

    {draft.fileSource === 'upload' ? <>
      <div onDragOver={(event) => { event.preventDefault(); if (!creating) setDragging(true) }}
        onDragLeave={() => setDragging(false)} onDrop={onDrop}
        className={'mt-3 flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-5 text-center transition-colors ' +
          (dragging ? 'border-accent bg-accent/5' : 'border-line bg-surface')}>
        <Upload aria-hidden size={18} className="text-fg-subtle" />
        {draft.fileName ? <>
          <p className="flex min-w-0 items-center gap-1.5 break-all font-mono text-xs text-fg"><File aria-hidden size={13} className="shrink-0 text-fg-subtle" />{draft.fileName}</p>
          <p className="text-xs text-fg-subtle">{draft.fileSizeMb === undefined ? '大小未知' : draft.fileSizeMb + ' MB'}</p>
        </> : <p className="text-xs text-fg-muted">把 SQLite 数据库文件拖到这里</p>}
        <label htmlFor="db-create-file" className={BUTTON + (creating ? ' pointer-events-none opacity-50' : ' cursor-pointer')}>选择本地文件</label>
        <input id="db-create-file" ref={inputRef} type="file" disabled={creating}
          accept={'.db,.sqlite,.sqlite3,' + SQLITE_FILE_SUFFIX + ',application/vnd.sqlite3,application/x-sqlite3'}
          className="sr-only" onChange={(event) => { if (event.target.files?.[0]) onPickFile(event.target.files[0]) }} />
        <p className="text-xs leading-5 text-fg-subtle">{real
          ? '上传独立、完整的 SQLite 快照。正在使用 WAL 的数据库请先导出快照。上限 256 MiB。'
          : '仅记录文件名与大小；文件内容不会上传或保存。'}</p>
      </div>
      {showErrors && errors.file ? <p className={ERROR} role="alert">{errors.file}</p> : null}
    </> : <>
      {!real ? <div className="mt-4">
        <label htmlFor="db-create-directory" className={LABEL}>落点目录 <span className="text-danger">*</span></label>
        <input id="db-create-directory" value={draft.directory} disabled={creating}
          onChange={(event) => onPatch({ directory: event.target.value })}
          autoComplete="off" spellCheck={false} className={FIELD + ' font-mono'} />
        {showErrors && errors.directory ? <p className={ERROR} role="alert">{errors.directory}</p> : null}
      </div> : null}
      <p className="mt-3 text-xs leading-5 text-fg-subtle">{real
        ? '文件将创建在面板管理目录 ~/.Elysian/data/sqlite；没有容器和账号。'
        : '仅模拟一个 ' + SQLITE_FILE_SUFFIX + ' 文件路径，不会在本机创建文件；没有容器和账号。'}</p>
    </>}

    <p className="mt-3 break-all rounded-lg bg-surface-raised px-3 py-2 font-mono text-xs text-fg-muted">
      {real ? '管理目录：~/.Elysian/data/sqlite（文件名由服务端生成）'
        : draft.name.trim() ? sqliteFilePath(draft) : '落点：' + draft.directory + '/{数据库名}' + SQLITE_FILE_SUFFIX}
    </p>
  </section>
}

export function DatabaseCreateDialog() {
  const gateway = useGateway()
  const engine = useDatabaseStore((state) => state.engine)
  const open = useDatabaseStore((state) => state.createOpen)
  const creating = useDatabaseStore((state) => state.creating)
  const createError = useDatabaseStore((state) => state.createError)
  const uploadPercent = useDatabaseStore((state) => state.uploadPercent)
  const databases = useDatabaseStore((state) => state.databases)
  const closeCreate = useDatabaseStore((state) => state.closeCreate)
  const createDatabase = useDatabaseStore((state) => state.createDatabase)
  const [draft, setDraft] = useState(() => emptyDraft(engine))
  const [showErrors, setShowErrors] = useState(false)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)

  useEffect(() => {
    if (open) {
      setDraft(emptyDraft(engine))
      setShowErrors(false)
      setSelectedFile(null)
    }
    // 弹窗每次打开都按当时的引擎重置草稿。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open) return null
  if (engine !== 'SQLite') return <RealDatabaseCreateDialog engine={engine} />
  const real = isDockerRuntime()
  const errors = {
    ...validateDatabaseCreateDraft(draft, databases, engine),
    ...(real && selectedFile && selectedFile.size > 256 * 1024 ** 2 ? { file: 'SQLite 文件超过 256 MiB 上传上限' } : {}),
  }
  const disabled = creating || (showErrors && hasDatabaseCreateErrors(errors))
  const patch = (part: Partial<DatabaseCreateDraft>) => setDraft((current) => ({ ...current, ...part }))
  const pickFile = (file: File) => {
    setSelectedFile(file)
    patch({
      fileName: file.name,
      fileSizeMb: bytesToMb(file.size),
      ...(!draft.name.trim() || draft.name === databaseNameFromFile(draft.fileName)
        ? { name: databaseNameFromFile(file.name) } : {}),
    })
  }
  const submit = () => {
    setShowErrors(true)
    if (hasDatabaseCreateErrors(errors)) return
    const input = toDatabaseCreateInput(draft, engine)
    if (input.kind === 'file' && real && input.origin === 'uploaded') {
      if (!selectedFile) return
      input.file = selectedFile
    }
    void createDatabase(gateway, input)
  }

  return <Dialog.Root open onOpenChange={(next) => { if (!next && !creating) closeCreate() }}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
      <Dialog.Content aria-describedby={undefined}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        className="fixed left-1/2 top-1/2 z-[55] flex max-h-[min(44rem,calc(100vh-2rem))] w-[min(42rem,calc(100vw-1.5rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-line bg-bg shadow-2xl">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-5 py-3">
          <div className="flex min-w-0 items-center gap-2">
            {!real ? <span className="shrink-0 rounded bg-warning/15 px-1.5 py-0.5 text-xs font-medium text-warning">演示</span> : null}
            <Dialog.Title className="truncate text-base font-semibold text-fg">添加 SQLite 数据库</Dialog.Title>
          </div>
          <button type="button" onClick={closeCreate} disabled={creating} aria-label="关闭弹窗"
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-fg-muted hover:bg-surface-raised disabled:opacity-50"><X aria-hidden size={16} /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          <section aria-labelledby="db-create-details-title">
            <h3 id="db-create-details-title" className="mb-3 text-sm font-semibold text-fg">数据库信息</h3>
            <label htmlFor="db-create-name" className={LABEL}>数据库名（取自文件名） <span className="text-danger">*</span></label>
            <input id="db-create-name" value={draft.name} disabled={creating} onChange={(event) => patch({ name: event.target.value })}
              placeholder="例如 elysian-notes" autoComplete="off" spellCheck={false}
              aria-describedby={showErrors && errors.name ? 'db-create-name-error' : undefined}
              className={FIELD + ' font-mono'} />
            {showErrors && errors.name ? <p id="db-create-name-error" className={ERROR} role="alert">{errors.name}</p> : null}
          </section>
          <SqliteFileField draft={draft} real={real} errors={errors} showErrors={showErrors} creating={creating}
            onPatch={patch} onPickFile={pickFile} />
          {createError ? <p role="alert" className="mt-4 text-xs text-danger">{createError}</p> : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3">
          <p className="text-xs text-fg-subtle">{real
            ? uploadPercent !== undefined ? '上传进度 ' + uploadPercent + '%' : '数据库文件保存在面板持久卷中。'
            : '所有数据仅存在于演示内存。'}</p>
          <div className="ml-auto flex gap-2">
            <button type="button" onClick={closeCreate} disabled={creating} className={BUTTON}>取消</button>
            <button type="button" onClick={submit} disabled={disabled} className={BUTTON + ' bg-surface-raised'}>
              {creating ? <Loader2 aria-hidden size={13} className="mr-1.5 animate-spin" /> : null}
              {creating ? real && draft.fileSource === 'upload' ? '上传中…' : '创建中…'
                : real && draft.fileSource === 'upload' ? '上传并创建' : '创建'}
            </button>
          </div>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}
