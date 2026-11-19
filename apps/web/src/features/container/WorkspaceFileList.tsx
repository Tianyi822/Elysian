import { containerAppFilePath, type ContainerApp, type ContainerAppFile } from '@elysian/contracts'
import { formatDateTime } from '../../components/format'
import { IconButton } from '../../components/IconButton'
import { File as FileIcon, Pencil, ShieldCheck, Trash2 } from '../../components/icons'
import { appWritingKey, isComposeFile } from '../../stores/containerAppsStore'
import { CopyPathButton } from './CopyPathButton'
import { formatWorkspaceSize } from './formatWorkspaceSize'

export function WorkspaceFileList({ app, writing, checkingPath, onCheck, onEdit, onRemove }: {
  app: ContainerApp
  writing: string | null
  checkingPath?: string
  onCheck: (path: string) => void
  onEdit: (path: string) => void
  onRemove: (path: string) => void
}) {
  return app.files.length === 0 ? (
    <p className="flex items-center gap-1.5 text-xs text-fg-subtle">
      <FileIcon aria-hidden size={13} />
      还没有文件，先上传 compose.yml、.env 或配置目录。
    </p>
  ) : (
    <ul className="space-y-1" aria-label={`${app.displayName} 的文件`}>
      {app.files.map((file: ContainerAppFile) => {
        const absolute = containerAppFilePath(app, file)
        const rowBusy = writing === appWritingKey(app.slug, file.path)
        const checkingHere = checkingPath === file.path
        return (
          <li
            key={file.path}
            className="rounded-lg px-2 py-2 transition-colors hover:bg-surface-raised/60"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1 space-y-1">
                <p className={`break-all font-mono text-xs ${rowBusy ? 'text-fg-subtle' : 'text-fg'}`}>
                  {file.path}
                </p>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs tabular-nums text-fg-subtle">
                  {rowBusy ? <span>写入中…</span> : null}
                  <span>{formatWorkspaceSize(file.size)}</span>
                  <span>{formatDateTime(file.modifiedAt)}</span>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <CopyPathButton value={absolute} label="文件真实路径" />
                {isComposeFile(file.path) ? (
                  <IconButton
                    label="自检引用路径"
                    variant="ghost"
                    onPress={() => onCheck(file.path)}
                    busy={checkingHere}
                  >
                    <ShieldCheck aria-hidden size={13} />
                  </IconButton>
                ) : null}
                <IconButton
                  label={file.text ? '编辑内容' : '二进制文件不支持编辑'}
                  variant="ghost"
                  disabled={!file.text || rowBusy}
                  onPress={() => onEdit(file.path)}
                >
                  <Pencil aria-hidden size={13} />
                </IconButton>
                <IconButton
                  label="删除文件"
                  variant="ghost"
                  tone="danger-hover"
                  disabled={rowBusy}
                  onPress={() => onRemove(file.path)}
                >
                  <Trash2 aria-hidden size={13} />
                </IconButton>
              </div>
            </div>
            <p className="mt-1.5 break-all font-mono text-xs leading-relaxed text-fg-subtle">
              {absolute}
            </p>
          </li>
        )
      })}
    </ul>
  )
}
