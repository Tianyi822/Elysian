import { createBrowserRouter, createMemoryRouter } from 'react-router'
import type { RouteObject } from 'react-router'
import type { ComponentType } from 'react'
import { ContainerPage } from '../features/container/ContainerPage'
import { ContainerViewSwitch } from '../features/container/ContainerViewSwitch'
import { DashboardPage } from '../features/dashboard/DashboardPage'
import { DatabaseEngineSwitch } from '../features/database/DatabaseEngineSwitch'
import { DatabasePage } from '../features/database/DatabasePage'
import { FilesPage } from '../features/files/FilesPage'
import { FilesPathTitle } from '../features/files/FilesPathTitle'
import { LogsPage } from '../features/logs/LogsPage'
import { LogsTabSwitch } from '../features/logs/LogsTabSwitch'
import { SecurityPage } from '../features/security/SecurityPage'
import { SecurityTabSwitch } from '../features/security/SecurityTabSwitch'
import { TerminalPage } from '../features/terminal/TerminalPage'
import { WebsitesPage } from '../features/websites/WebsitesPage'
import { AppShell } from './layout/AppShell'
import { NotFoundPage } from './NotFoundPage'
import { RequireArea } from './RequireArea'

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

/**
 * 路由表只有这一份。本阶段仪表盘为主界面，Docker 区承载容器与镜像两个视图，
 * 后续界面按同一模板回归时在这里加路由。
 */
export const routes: RouteObject[] = [
  {
    path: '/',
    element: <AppShell />,
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
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]

export const browserRouter = createBrowserRouter(routes)

/** 测试用内存路由，避免测试依赖浏览器地址栏。 */
export function createAppRouter(initialEntries: string[] = ['/']) {
  return createMemoryRouter(routes, { initialEntries })
}
