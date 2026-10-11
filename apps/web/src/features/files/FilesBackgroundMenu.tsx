import * as ContextMenu from '@radix-ui/react-context-menu'
import type { ReactNode } from 'react'
import { Upload } from '../../components/icons'
import { FileMenuContent, FileMenuItem } from './FileMenu'

/** 只包围列表区域，空目录与表格下方留白也提供同一个上传入口。 */
export function FilesBackgroundMenu({ children, onUpload, disabled }: {
  children: ReactNode
  onUpload(): void
  disabled: boolean
}) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div aria-label="文件列表操作区域" className="min-h-64 pb-12" tabIndex={0}>
          {children}
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <FileMenuContent>
          <FileMenuItem
            icon={Upload}
            disabled={disabled}
            onSelect={onUpload}
          >
            上传至当前目录
          </FileMenuItem>
        </FileMenuContent>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}
