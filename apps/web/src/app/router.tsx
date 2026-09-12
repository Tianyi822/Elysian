import { createBrowserRouter, createMemoryRouter } from 'react-router'
import type { RouteObject } from 'react-router'
import { AgentRunsPage } from '../features/runs/AgentRunsPage'
import { ApprovalQueuePage } from '../features/approvals/ApprovalQueuePage'
import { AuditLogPage } from '../features/audit/AuditLogPage'
import { IncidentDetailPage } from '../features/incidents/IncidentDetailPage'
import { IncidentListPage } from '../features/incidents/IncidentListPage'
import { OverviewPage } from '../features/overview/OverviewPage'
import { SettingsPage } from '../features/settings/SettingsPage'
import { SkillCatalogPage } from '../features/skills/SkillCatalogPage'
import { AppShell } from './layout/AppShell'
import { NotFoundPage } from './NotFoundPage'

/**
 * 路由表只有这一份。一级路由对应侧边栏七项，事故详情是事件中心的子路由。
 * 筛选条件放在 search params 里，因此这里不需要为筛选再开路由。
 */
export const routes: RouteObject[] = [
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <OverviewPage /> },
      { path: 'incidents', element: <IncidentListPage /> },
      { path: 'incidents/:incidentId', element: <IncidentDetailPage /> },
      { path: 'runs', element: <AgentRunsPage /> },
      { path: 'skills', element: <SkillCatalogPage /> },
      { path: 'approvals', element: <ApprovalQueuePage /> },
      { path: 'audit', element: <AuditLogPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]

export const browserRouter = createBrowserRouter(routes)

/** 测试用内存路由，避免测试依赖浏览器地址栏。 */
export function createAppRouter(initialEntries: string[] = ['/']) {
  return createMemoryRouter(routes, { initialEntries })
}
