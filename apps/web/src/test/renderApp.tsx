import * as Tooltip from '@radix-ui/react-tooltip'
import { render } from '@testing-library/react'
import { RouterProvider } from 'react-router'
import { GatewayProvider } from '../adapters/GatewayProvider'
import { createMockGateway } from '../adapters/mock/gateway'
import { MockSessionAdapter } from '../adapters/mock/mockAdapters'
import { createAppRouter } from '../app/router'
import { RoutedThemeProvider } from '../app/theme/ThemeProvider'
import type { ElysianGateway } from '../contracts/adapters'
import { useSessionStore } from '../stores/sessionStore'

/**
 * 测试统一从这里渲染整棵应用树，provider 结构与 App 一致。
 * 传入 gateway 即可在唯一的适配接缝上替换数据来源。
 * 返回 router，便于断言地址（筛选条件）是否与预期一致。
 *
 * 未注入网关时，默认网关直接用内存事件源并把节奏调到一分钟一次：
 * 测试因此既不依赖服务端进程，也不会有定时器在断言中途插入事件。
 */
export function renderApp(path = '/', options: { gateway?: ElysianGateway } = {}) {
  const router = createAppRouter([path])
  const gateway = options.gateway ?? createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
  // 同步渲染辅助模拟应用入口已完成演示探测；显式注入的会话仍交给路由探测。
  if (gateway.session instanceof MockSessionAdapter) {
    useSessionStore.setState({ phase: 'authed', mode: 'demo', devAccount: false, username: 'admin' })
  }

  const view = render(
    <RoutedThemeProvider router={router}>
      <Tooltip.Provider delayDuration={0}>
        <GatewayProvider gateway={gateway}>
          <RouterProvider router={router} />
        </GatewayProvider>
      </Tooltip.Provider>
    </RoutedThemeProvider>,
  )

  return { ...view, router }
}
