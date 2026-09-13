import { LayoutDashboard } from 'lucide-react'

export type NavItem = {
  to: string
  label: string
  icon: typeof LayoutDashboard
  /** 只有总览入口需要精确匹配。 */
  end?: boolean
}

/** 本阶段侧边栏只有仪表盘一项；后续界面按同一模板逐个回归（ADR-0007）。 */
export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/', label: '仪表盘', icon: LayoutDashboard, end: true },
]
