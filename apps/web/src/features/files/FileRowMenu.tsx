import * as ContextMenu from '@radix-ui/react-context-menu'
import type { ReactNode } from 'react'
import type { FileEntry } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { useFilesStore } from '../../stores/filesStore'

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
  children,
}: {
  entry: FileEntry
  entryPath: string
  onRename(entry: FileEntry, entryPath: string): void
  onPermission(entry: FileEntry, entryPath: string): void
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
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="z-50 min-w-36 rounded-lg border border-line bg-surface p-1 text-xs shadow-lg">
          <MenuItem onSelect={() => copyToClipboard(entryPath)}>复制</MenuItem>
          {entry.kind === 'directory' ? (
            <MenuItem
              disabled={clipboard === undefined}
              onSelect={() => void paste(gateway, entryPath)}
            >
              粘贴到此目录
            </MenuItem>
          ) : null}
          <MenuItem onSelect={() => moveToClipboard(entryPath)}>移动</MenuItem>
          <ContextMenu.Separator className="my-1 h-px bg-line" />
          <MenuItem onSelect={() => onRename(entry, entryPath)}>重命名</MenuItem>
          <MenuItem onSelect={() => onPermission(entry, entryPath)}>权限</MenuItem>
          <MenuItem onSelect={() => void compress(gateway, entryPath)}>压缩</MenuItem>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}

function MenuItem({
  children,
  disabled,
  onSelect,
}: {
  children: string
  disabled?: boolean
  onSelect(): void
}) {
  return (
    <ContextMenu.Item
      disabled={disabled}
      onSelect={onSelect}
      className="flex cursor-default select-none items-center rounded px-2 py-1.5 text-fg-muted outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface-raised data-[highlighted]:text-fg"
    >
      {children}
    </ContextMenu.Item>
  )
}
