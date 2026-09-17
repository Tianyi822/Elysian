import { Container, Database, FolderTree, LayoutDashboard, ScrollText, ShieldCheck } from '../components/icons'
import type { IconComponent } from '../components/icons'

export type NavItem = {
  to: string
  label: string
  icon: IconComponent
  /** 只有总览入口需要精确匹配。 */
  end?: boolean
}

/** 侧边栏导航项；显示名取产品命名，路由路径保持领域词。 */
export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/', label: '仪表盘', icon: LayoutDashboard, end: true },
  { to: '/security', label: '安全', icon: ShieldCheck },
  { to: '/containers', label: 'Docker', icon: Container },
  { to: '/databases', label: '数据库', icon: Database },
  { to: '/files', label: '文件管理', icon: FolderTree },
  { to: '/logs', label: '平台日志', icon: ScrollText },
]
