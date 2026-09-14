import { Container, LayoutDashboard } from 'lucide-react'

export type NavItem = {
  to: string
  label: string
  icon: typeof LayoutDashboard
  /** 只有总览入口需要精确匹配。 */
  end?: boolean
}

/** 侧边栏导航项；容器页本期只是空白占位，内容待后续设计落地。 */
export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/', label: '仪表盘', icon: LayoutDashboard, end: true },
  { to: '/containers', label: '容器', icon: Container },
]
