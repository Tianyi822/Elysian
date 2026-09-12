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
import { RequireArea } from './RequireArea'

/**
 * 路由表只有这一份。一级路由对应侧边栏七项，事故详情是事件中心的子路由。
 * 筛选条件放在 search params 里，因此这里不需要为筛选再开路由。
 * 每个页面都包在 RequireArea 里：无权限状态在路由层统一承载，页面自己不管权限。
 */
export const routes: RouteObject[] = [
  {
    path: '/',
    element: <AppShell />,
    children: [
      {
        index: true,
        element: (
          <RequireArea area="overview" title="总览" description="当前事故、Agent 运行、待审批动作与服务健康摘要。">
            <OverviewPage />
          </RequireArea>
        ),
      },
      {
        path: 'incidents',
        element: (
          <RequireArea area="incidents" title="事件中心" description="事故、告警与待处理任务的合并列表。">
            <IncidentListPage />
          </RequireArea>
        ),
      },
      {
        path: 'incidents/:incidentId',
        element: (
          <RequireArea area="incidents" title="事故详情" description="时间线、证据与判断、建议动作与审批状态。">
            <IncidentDetailPage />
          </RequireArea>
        ),
      },
      {
        path: 'runs',
        element: (
          <RequireArea area="runs" title="Agent 运行" description="按职责模块查看运行状态与事件时间线。">
            <AgentRunsPage />
          </RequireArea>
        ),
      },
      {
        path: 'skills',
        element: (
          <RequireArea area="skills" title="技能目录" description="技能清单、manifest 声明与启停状态。">
            <SkillCatalogPage />
          </RequireArea>
        ),
      },
      {
        path: 'approvals',
        element: (
          <RequireArea area="approvals" title="审批队列" description="待审批动作、影响范围与风险说明。">
            <ApprovalQueuePage />
          </RequireArea>
        ),
      },
      {
        path: 'audit',
        element: (
          <RequireArea area="audit" title="审计日志" description="事件、决策、工具调用、审批与执行结果的时间顺序记录。">
            <AuditLogPage />
          </RequireArea>
        ),
      },
      {
        path: 'settings',
        element: (
          <RequireArea area="settings" title="系统设置" description="主题、事件源状态与演示数据说明。">
            <SettingsPage />
          </RequireArea>
        ),
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]

export const browserRouter = createBrowserRouter(routes)

/** 测试用内存路由，避免测试依赖浏览器地址栏。 */
export function createAppRouter(initialEntries: string[] = ['/']) {
  return createMemoryRouter(routes, { initialEntries })
}
