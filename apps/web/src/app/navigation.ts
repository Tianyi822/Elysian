import { Blocks, Bot, LayoutDashboard, ScrollText, Settings, ShieldCheck, Siren } from 'lucide-react'

export type NavItem = {
  to: string
  label: string
  icon: typeof LayoutDashboard
  /** 只有总览需要精确匹配，否则 `/` 会匹配所有路径。 */
  end?: boolean
}

export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/', label: '总览', icon: LayoutDashboard, end: true },
  { to: '/incidents', label: '事件中心', icon: Siren },
  { to: '/runs', label: 'Agent 运行', icon: Bot },
  { to: '/skills', label: '技能目录', icon: Blocks },
  { to: '/approvals', label: '审批队列', icon: ShieldCheck },
  { to: '/audit', label: '审计日志', icon: ScrollText },
  { to: '/settings', label: '系统设置', icon: Settings },
]
