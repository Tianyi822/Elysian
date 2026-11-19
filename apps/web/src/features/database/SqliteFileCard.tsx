import { DATABASE_STATUS_LABELS, type DatabaseInstance, type DatabaseStatus } from '@elysian/contracts'
import { Check, Database, Download, File, Timer, Trash2 } from '../../components/icons'
import { useState } from 'react'
import { useGateway } from '../../adapters/GatewayProvider'
import { Button } from '../../components/Button'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { useClipboardCopy } from '../../components/CopyButton'
import { formatDateTime } from '../../components/format'
import { StatusTag, type StatusTone } from '../../components/StatusTag'
import { useFeedbackMessage } from '../../components/useFeedbackMessage'
import { useDatabaseStore } from '../../stores/databaseStore'
import { useMessageStore } from '../../stores/messageStore'
import { captureAuthGeneration } from '../../utils/authGeneration'
import { messageOf } from '../../utils/errorMessage'
import { DatabaseMark, FileStat } from './databaseCardParts'

const FILE_STATUS_TONE: Record<DatabaseStatus, StatusTone> = {
  running: 'success',
  warning: 'warning',
  stopped: 'danger',
}

/** SQLite 文件卡：就是一个本地文件，没有容器、没有账号、没有连接入口。 */
export function SqliteFileCard({
  file,
  removing,
  onRemove,
}: {
  file: DatabaseInstance
  removing: boolean
  onRemove(): void
}) {
  const gateway = useGateway()
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [actionError, setActionError] = useState('')
  useFeedbackMessage(actionError)
  const { copied: pathCopied, copy: copyFilePath } = useClipboardCopy()

  const performAction = async (action: () => Promise<unknown>, message: string, changed = false) => {
    const auth = captureAuthGeneration()
    setActionError('')
    try {
      await action()
      if (auth !== captureAuthGeneration()) return
      useMessageStore.getState().notify({ tone: 'success', message })
      if (changed) await useDatabaseStore.getState().refreshAfterMutation(gateway, 'file')
    } catch (error) {
      if (auth === captureAuthGeneration()) setActionError(messageOf(error, '数据库操作失败'))
    }
  }

  return (
    <article
      aria-label={`SQLite 数据库 ${file.name}`}
      className="@container flex h-full flex-col gap-3 panel-surface p-4 md:p-5"
    >
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1">
        <div className="row-span-2 flex items-center">
          <DatabaseMark engine={file.engine} />
        </div>
        <h3 className="truncate text-sm font-semibold">{file.name}</h3>
        <StatusTag
          label={file.needsAttention ? file.status === 'stopped' ? '文件不可用' : '需要处理' : DATABASE_STATUS_LABELS[file.status]}
          tone={FILE_STATUS_TONE[file.status]}
        />
        <p className="truncate text-xs text-fg-muted">
          {file.engine} · {file.version}
        </p>
        <time dateTime={file.updatedAt} className="whitespace-nowrap text-xs text-fg-subtle">
          更新于 {formatDateTime(file.updatedAt)}
        </time>
      </div>
      {/* 文件型：来源是一个本地 .db 文件，没有容器详情可看；点击把路径复制走。 */}
      <Button unstyled
        type="button"
        onClick={() => void copyFilePath(file.filePath ?? '', '文件路径')}
        title="点击复制文件路径"
        aria-label={`复制数据库文件路径 ${file.filePath ?? ''}`}
        className="flex w-full items-center gap-2 rounded-lg bg-surface-raised px-3 py-2 text-left text-xs text-fg-muted transition-colors hover:bg-surface-raised/70 hover:text-fg"
      >
        {pathCopied ? (
          <Check aria-hidden size={14} className="shrink-0 text-success" />
        ) : (
          <File aria-hidden size={14} className="shrink-0 text-fg-subtle" />
        )}
        <span className="hidden shrink-0 @sm:inline">{pathCopied ? '已复制' : '数据库文件'}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-fg" title={file.filePath}>
          {file.filePath}
        </span>
        <span className="hidden shrink-0 tabular-nums text-fg-subtle @xs:inline">
          {formatFileSize(file.fileSizeMb)}
        </span>
      </Button>

      {/* 文件型只有事实，没有配额：三格都是静态值，不画占比条。 */}
      <div className="grid grid-cols-1 gap-2.5 @lg:grid-cols-3">
        <FileStat
          icon={<File aria-hidden size={14} />}
          label="文件大小"
          value={formatFileSize(file.fileSizeMb)}
        />
        <FileStat
          icon={<Database aria-hidden size={14} />}
          label="表数量"
          value={file.tableCount === undefined ? '不可用' : String(file.tableCount)}
        />
        <FileStat
          icon={<Timer aria-hidden size={14} />}
          label="最后写入"
          value={file.lastWrittenAt ? formatDateTime(file.lastWrittenAt) : '不可用'}
        />
      </div>
      {file.metricsError ? <p role="status" className="text-xs text-warning">状态核对失败：{file.metricsError}</p> : null}
      {file.needsAttention ? <div className="rounded-lg border border-warning/40 p-2 text-xs text-warning"><p>SQLite 文件不可用或操作尚未完成。可重新核对；确认放弃时可清理登记及残留文件。</p><div className="mt-2 flex gap-2"><Button variant="outline" type="button" onClick={() => void performAction(() => gateway.databases.reconcileSqlite(file.id), `SQLite 文件 ${file.name} 已重新核对`, true)} className="rounded border border-line px-2 py-1">重新核对</Button><Button variant="outline" type="button" onClick={() => void performAction(() => gateway.databases.forgetSqlite(file.id), `已清理 SQLite 文件 ${file.name} 的待处理登记`, true)} className="rounded border border-line px-2 py-1">清理待处理文件</Button></div></div> : null}

      <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {file.source === 'managed' && file.status === 'running' ? <Button variant="outline" type="button" onClick={() => void performAction(() => gateway.databases.downloadSqlite(file.id), `已发起数据库 ${file.name} 的快照下载`)} title="下载一致性 SQLite 快照" className="action-button gap-1.5 border border-line px-3 py-1.5 text-xs"><Download aria-hidden size={13} />下载快照</Button> : null}
          <Button variant="destructive"
            type="button"
            onClick={() => setConfirmRemove(true)}
            disabled={removing}
            className="action-button shrink-0 gap-1.5 border border-danger/40 px-3 py-1.5 text-xs text-danger transition-colors hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Trash2 aria-hidden size={13} />
            删除文件
          </Button>
        </div>
      </div>
      {confirmRemove ? (
        <ConfirmDialog
          title={`确认删除 SQLite 文件「${file.name}」？`}
          description={<p className="mt-1.5 text-xs text-fg-muted">将永久删除面板管理目录中的实际 SQLite 数据库文件。请先下载快照备份；此操作无法撤销。</p>}
          danger confirmLabel="确认删除"
          onClose={() => setConfirmRemove(false)}
          onConfirm={() => { setConfirmRemove(false); onRemove() }}
        />
      ) : null}
    </article>
  )
}

/** 文件大小：小于 1MB 用 KB，其余用 MB，避免「0.0 MB」这种读不出信息的显示。 */
function formatFileSize(sizeMb: number | undefined): string {
  if (sizeMb === undefined) return '不可用'
  if (sizeMb < 0.1) return `${Math.round(sizeMb * 1024)} KB`
  return `${sizeMb.toFixed(1)} MB`
}
