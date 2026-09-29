import { Container, Database, FolderTree, Globe, LayoutDashboard, ScrollText, ShieldCheck, Terminal } from '../components/icons'
import type { IconComponent } from '../components/icons'

export type NavItem = {
  to: string
  label: string
  icon: IconComponent
  /** 只有总览入口需要精确匹配。 */
  end?: boolean
}

/** 侧边栏导航项；路由路径与显示名保持一致（领域词，产品名不同的取产品名，如 Docker）。 */
export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/', label: '仪表盘', icon: LayoutDashboard, end: true },
  { to: '/security', label: '安全', icon: ShieldCheck },
  { to: '/docker', label: 'Docker', icon: Container },
  { to: '/databases', label: '数据库', icon: Database },
  { to: '/files', label: '文件管理', icon: FolderTree },
  { to: '/logs', label: '平台日志', icon: ScrollText },
  { to: '/terminals', label: '终端', icon: Terminal },
  { to: '/websites', label: '网站', icon: Globe },
]
