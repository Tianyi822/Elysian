import * as ContextMenu from '@radix-ui/react-context-menu'
import type { ReactNode } from 'react'
import type { FileEntry } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { useFilesStore } from '../../stores/filesStore'
import { ClipboardPaste, Copy, Download, FileArchive, FolderInput, KeyRound, Pencil, Upload } from '../../components/icons'
import { FileMenuContent, FileMenuItem } from './FileMenu'

/**
 * 表格行的右键菜单：复制、粘贴、移动、重命名、权限、压缩，对齐系统文件管理器的操作面。
 *
 * 复制与移动只是把条目暂存进内存剪贴板（intent 区分），粘贴才落数据；
 * 粘贴项只在目录行出现——粘进那个目录，粘进当前目录走工具栏按钮。
 * 行本就可键盘聚焦，Radix 原生支持 Menu 键呼出，右键不是唯一入口。
 */
export function FileRowMenu({
  entry,
  entryPath,
  onRename,
  onPermission,
  onDownload,
  onUpload,
  transferBusy = false,
  children,
}: {
  entry: FileEntry
  entryPath: string
  onRename(entry: FileEntry, entryPath: string): void
  onPermission(entry: FileEntry, entryPath: string): void
  onDownload(entry: FileEntry, entryPath: string): void
  onUpload(entry: FileEntry, entryPath: string): void
  transferBusy?: boolean
  children: ReactNode
}) {
  const gateway = useGateway()
  const clipboard = useFilesStore((s) => s.clipboard)
  const copyToClipboard = useFilesStore((s) => s.copyToClipboard)
  const moveToClipboard = useFilesStore((s) => s.moveToClipboard)
  const paste = useFilesStore((s) => s.paste)
  const compress = useFilesStore((s) => s.compress)

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild onContextMenu={(event) => event.stopPropagation()}>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <FileMenuContent>
          <FileMenuItem icon={Download} onSelect={() => onDownload(entry, entryPath)}>下载</FileMenuItem>
          <FileMenuItem icon={Upload} disabled={transferBusy} onSelect={() => onUpload(entry, entryPath)}>
            {entry.kind === 'directory' ? '上传至该目录' : '上传至当前目录'}
          </FileMenuItem>
          <FileMenuItem icon={Copy} onSelect={() => copyToClipboard(entryPath)}>复制</FileMenuItem>
          {entry.kind === 'directory' ? (
            <FileMenuItem
              icon={ClipboardPaste}
              disabled={clipboard === undefined}
              onSelect={() => void paste(gateway, entryPath)}
            >
              粘贴到此目录
            </FileMenuItem>
          ) : null}
          <FileMenuItem icon={FolderInput} onSelect={() => moveToClipboard(entryPath)}>移动</FileMenuItem>
          <FileMenuItem icon={Pencil} onSelect={() => onRename(entry, entryPath)}>重命名</FileMenuItem>
          <FileMenuItem icon={KeyRound} onSelect={() => onPermission(entry, entryPath)}>权限</FileMenuItem>
          <FileMenuItem icon={FileArchive} onSelect={() => void compress(gateway, entryPath)}>压缩</FileMenuItem>
        </FileMenuContent>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}
