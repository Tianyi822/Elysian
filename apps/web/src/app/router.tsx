import { createBrowserRouter, createMemoryRouter } from 'react-router'
import type { RouteObject } from 'react-router'
import type { ComponentType } from 'react'
import { ContainerPage } from '../features/container/ContainerPage'
import { ContainerViewSwitch } from '../features/container/ContainerViewSwitch'
import { DashboardPage } from '../features/dashboard/DashboardPage'
import { AppShell } from './layout/AppShell'
import { NotFoundPage } from './NotFoundPage'
import { RequireArea } from './RequireArea'

/** 路由级外壳插槽：页面经 handle 向顶栏标题旁贡献控件，外壳不硬编码具体页面。 */
export type RouteHandle = {
  headerAccessory?: ComponentType
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
        path: 'containers',
        handle: { headerAccessory: ContainerViewSwitch } satisfies RouteHandle,
        element: (
          <RequireArea area="containers" title="Docker">
            <ContainerPage />
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
