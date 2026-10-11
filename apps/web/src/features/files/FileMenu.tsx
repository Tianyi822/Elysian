import * as ContextMenu from '@radix-ui/react-context-menu'
import type { ReactNode } from 'react'
import type { IconComponent } from '../../components/icons'

/** 行菜单与空白菜单共用外壳、图标和高亮形状。 */
export function FileMenuContent({ children }: { children: ReactNode }) {
  return (
    <ContextMenu.Content collisionPadding={8} className="file-menu z-50">
      {children}
    </ContextMenu.Content>
  )
}

export function FileMenuItem({ children, icon: Icon, disabled, onSelect }: {
  children: string
  icon: IconComponent
  disabled?: boolean
  onSelect(): void
}) {
  return (
    <ContextMenu.Item disabled={disabled} onSelect={onSelect} className="file-menu-item">
      <Icon aria-hidden size={15} strokeWidth={1.7} className="file-menu-icon" />
      <span>{children}</span>
    </ContextMenu.Item>
  )
}
