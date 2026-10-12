import { createBrowserRouter, createMemoryRouter, Navigate, useSearchParams } from 'react-router'
import type { RouteObject } from 'react-router'
import type { ComponentType } from 'react'
import { ContainerPage } from '../features/container/ContainerPage'
import { ContainerViewSwitch } from '../features/container/ContainerViewSwitch'
import { DashboardPage } from '../features/dashboard/DashboardPage'
import { DatabaseEngineSwitch } from '../features/database/DatabaseEngineSwitch'
import { DatabasePage } from '../features/database/DatabasePage'
import { FilesPage } from '../features/files/FilesPage'
import { FilesPathTitle } from '../features/files/FilesPathTitle'
import { LoginPage } from '../features/auth/LoginPage'
import { AgentChatPage } from '../features/agent/AgentChatPage'
import { LogsPage } from '../features/logs/LogsPage'
import { LogsTabSwitch } from '../features/logs/LogsTabSwitch'
import { SecurityPage } from '../features/security/SecurityPage'
import { SecurityTabSwitch } from '../features/security/SecurityTabSwitch'
import { SettingsPage } from '../features/settings/SettingsPage'
import { SettingsTabSwitch } from '../features/settings/SettingsTabSwitch'
import { TerminalPage } from '../features/terminal/TerminalPage'
import { WebsitesPage } from '../features/websites/WebsitesPage'
import { AppShell } from './layout/AppShell'
import { NotFoundPage } from './NotFoundPage'
import { RequireArea } from './RequireArea'
import { RequireSession } from './RequireSession'

/** 路由级外壳插槽：页面经 handle 向顶栏贡献控件与标题行为，外壳不硬编码具体页面。 */
export type RouteHandle = {
  headerAccessory?: ComponentType
  /** 页面自带页签式标题时置 true：顶栏不再渲染可视标题，页签占据标题位。 */
  hideHeaderTitle?: boolean
  /** 全屏型页面（如终端）置 true：整条顶栏不渲染，页面吃掉顶栏以下全部高度。 */
  hideHeader?: boolean
  /** 主区去掉内边距并禁止外层滚动，让全屏页自己吃高度。 */
  flushMain?: boolean
}

/** 尚未设计的 Agent 子页仅保留访问门禁与空白内容。 */
function agentPage(title: string) {
  return (
    <RequireArea area="agent" title={title}>
      {null}
    </RequireArea>
  )
}

/** 旧模型配置地址继续转到系统设置。 */
function AgentCapabilitiesRoute() {
  const [params] = useSearchParams()
  return params.get('tab') === 'models'
    ? <Navigate to="/settings?tab=models" replace />
    : agentPage('执行配置')
}

/**
 * 路由表只有这一份。本阶段仪表盘为主界面，Docker 区承载容器与镜像两个视图，
 * 后续界面按同一模板回归时在这里加路由。/login 是顶层平级路由（不进 AppShell、
 * 不包 RequireArea）；其余全部子路由在会话闸门（RequireSession）之内。
 */
export const routes: RouteObject[] = [
  { path: '/login', element: <LoginPage /> },
  {
    path: '/',
    element: (
      <RequireSession>
        <AppShell />
      </RequireSession>
    ),
    children: [
      {
        index: true,
        element: (
          <RequireArea area="dashboard" title="仪表盘">
            <DashboardPage />
          </RequireArea>
        ),
      },
      {
        path: 'security',
        handle: {
          headerAccessory: SecurityTabSwitch,
          hideHeaderTitle: true,
        } satisfies RouteHandle,
        element: (
          <RequireArea area="security" title="安全">
            <SecurityPage />
          </RequireArea>
        ),
      },
      {
        path: 'docker',
        handle: {
          headerAccessory: ContainerViewSwitch,
          hideHeaderTitle: true,
        } satisfies RouteHandle,
        element: (
          <RequireArea area="containers" title="Docker">
            <ContainerPage />
          </RequireArea>
        ),
      },
      {
        path: 'databases',
        handle: {
          headerAccessory: DatabaseEngineSwitch,
          hideHeaderTitle: true,
        } satisfies RouteHandle,
        element: (
          <RequireArea area="databases" title="数据库">
            <DatabasePage />
          </RequireArea>
        ),
      },
      {
        path: 'files/*',
        handle: {
          headerAccessory: FilesPathTitle,
          hideHeaderTitle: true,
        } satisfies RouteHandle,
        element: (
          <RequireArea area="files" title="文件管理">
            <FilesPage />
          </RequireArea>
        ),
      },
      {
        path: 'logs',
        handle: {
          headerAccessory: LogsTabSwitch,
          hideHeaderTitle: true,
        } satisfies RouteHandle,
        element: (
          <RequireArea area="logs" title="平台日志">
            <LogsPage />
          </RequireArea>
        ),
      },
      {
        path: 'terminals',
        handle: {
          hideHeader: true,
          flushMain: true,
        } satisfies RouteHandle,
        element: (
          <RequireArea area="terminals" title="终端">
            <TerminalPage />
          </RequireArea>
        ),
      },
      {
        path: 'websites',
        element: (
          <RequireArea area="websites" title="网站">
            <WebsitesPage />
          </RequireArea>
        ),
      },
      {
        path: 'agent',
        handle: { hideHeader: true, flushMain: true } satisfies RouteHandle,
        element: <RequireArea area="agent" title="Ely 工作台"><AgentChatPage /></RequireArea>,
      },
      {
        path: 'agent/approvals',
        element: agentPage('审批与治理'),
      },
      {
        path: 'agent/runs',
        element: agentPage('运行记录'),
      },
      {
        path: 'agent/workflows',
        element: agentPage('工作流'),
      },
      {
        path: 'agent/capabilities',
        element: <AgentCapabilitiesRoute />,
      },
      {
        path: 'agent/extensions',
        element: agentPage('技能与 MCP'),
      },
      {
        path: 'agent/memory',
        element: agentPage('长期记忆'),
      },
      {
        path: 'settings',
        handle: { headerAccessory: SettingsTabSwitch, hideHeaderTitle: true } satisfies RouteHandle,
        element: (
          <RequireArea area="settings" title="设置">
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
