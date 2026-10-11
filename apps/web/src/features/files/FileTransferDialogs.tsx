import * as Dialog from '@radix-ui/react-dialog'
import { Loader2 } from '../../components/icons'
import { CTL_PRIMARY } from '../../components/formControl'
import { formatEntrySize } from './filesListing'
import { useFilesStore } from '../../stores/filesStore'
import type { FileUploadItem } from '../../stores/filesStore'
import { isDockerRuntime } from '../../app/runtime/isDockerRuntime'

const DIALOG_CLASS = 'fixed left-1/2 top-1/2 z-[61] w-[min(34rem,calc(100vw-2rem))] max-h-[calc(100dvh-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto panel-surface p-5 shadow-xl'

export function FileDownloadDialog() {
  const download = useFilesStore((state) => state.download)
  const dismiss = useFilesStore((state) => state.dismissDownload)
  const cancel = useFilesStore((state) => state.cancelDownload)
  if (!download) return null
  const preparing = download.status === 'preparing'
  return (
    <Dialog.Root open onOpenChange={(open) => !open && dismiss()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay" />
        <Dialog.Content aria-describedby={undefined} className={DIALOG_CLASS}>
          <Dialog.Title className="text-sm font-semibold">下载「{download.name}」</Dialog.Title>
          <p className="mt-2 break-all font-mono text-xs text-fg-muted">{download.path}</p>
          <p role={download.status === 'error' ? 'alert' : 'status'} className={`mt-4 flex items-center gap-2 text-sm ${download.status === 'error' ? 'text-danger' : 'text-fg-muted'}`}>
            {preparing ? <Loader2 aria-hidden size={15} className="animate-spin" /> : null}
            {preparing ? (download.directory ? '正在打包为 tar.gz…' : '正在准备下载…')
              : download.status === 'started' ? '已开始下载，请在浏览器中查看下载进度。'
                : download.status === 'cancelled' ? '已取消准备下载。' : download.errorMessage}
          </p>
          <div className="mt-5 flex justify-end">
            <button type="button" onClick={preparing ? cancel : dismiss} className={CTL_PRIMARY}>
              {preparing ? '取消准备' : '关闭'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

const STATUS_LABELS: Record<FileUploadItem['status'], string> = {
  queued: '等待上传', checking: '检查目标文件', conflict: '等待确认', uploading: '正在上传',
  complete: '已上传', skipped: '已跳过', error: '失败', cancelled: '已取消',
}

export function FileUploadDialog() {
  const upload = useFilesStore((state) => state.upload)
  const decide = useFilesStore((state) => state.decideUploadConflict)
  const cancel = useFilesStore((state) => state.cancelUpload)
  const dismiss = useFilesStore((state) => state.dismissUpload)
  if (!upload) return null
  const conflict = upload.conflictIndex === undefined ? undefined : upload.items[upload.conflictIndex]
  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open && !upload.busy) dismiss() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay" />
        <Dialog.Content aria-describedby={undefined} className={DIALOG_CLASS}>
          <Dialog.Title className="text-sm font-semibold">上传文件</Dialog.Title>
          <p className="mt-2 text-xs text-fg-muted">目标目录</p>
          <p className="mt-1 break-all font-mono text-xs text-fg" aria-label="上传目标目录">{upload.targetPath}</p>
          {!isDockerRuntime() ? <p className="mt-2 text-xs text-fg-muted">演示模式：仅在内存中记录文件信息，刷新后重置。</p> : null}
          <ul aria-label="上传文件状态" className="mt-4 divide-y divide-line border-y border-line">
            {upload.items.map((item, index) => (
              <li key={index} className="py-3">
                <div className="flex items-start justify-between gap-4 text-xs">
                  <span className="min-w-0 break-all font-medium">{item.name}</span>
                  <span className="shrink-0 text-fg-muted">{STATUS_LABELS[item.status]}{item.status === 'uploading' ? ` ${Math.round(item.progress)}%` : ''}</span>
                </div>
                <p className="mt-1 text-xs text-fg-subtle">{formatEntrySize(item.sizeBytes)}</p>
                {item.status === 'uploading' ? <progress aria-label={`${item.name} 上传进度`} max={100} value={item.progress} className="mt-2 h-1.5 w-full accent-accent" /> : null}
                {item.errorMessage ? <p role={item.status === 'error' ? 'alert' : undefined} className="mt-1 text-xs text-danger">{item.errorMessage}</p> : null}
              </li>
            ))}
          </ul>
          {conflict ? (
            <div role="alert" className="mt-4 rounded-lg border border-line bg-surface-raised p-3">
              <p className="break-all text-sm">{conflict.replacing ? `「${conflict.name}」已存在，要覆盖吗？` : `「${conflict.name}」的目标已变化，要继续上传吗？`}</p>
              <div className="mt-3 flex justify-end gap-2">
                <button type="button" onClick={() => decide(false)} className={CTL_PRIMARY}>跳过此文件</button>
                <button type="button" onClick={() => decide(true)} className={CTL_PRIMARY}>{conflict.replacing ? '覆盖此文件' : '继续上传'}</button>
              </div>
            </div>
          ) : null}
          <div className="mt-5 flex items-center justify-between gap-3">
            <p role="status" className="text-xs text-fg-muted">{upload.busy ? '文件依次上传' : `已上传 ${upload.items.filter((item) => item.status === 'complete').length} / ${upload.items.length} 个文件`}</p>
            <button type="button" onClick={upload.busy ? cancel : dismiss} className={CTL_PRIMARY}>{upload.busy ? '取消上传' : '关闭'}</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
