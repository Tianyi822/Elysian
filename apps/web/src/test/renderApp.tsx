import * as Tooltip from '@radix-ui/react-tooltip'
import { render } from '@testing-library/react'
import { RouterProvider } from 'react-router'
import { GatewayProvider } from '../adapters/GatewayProvider'
import { createAppRouter } from '../app/router'
import { ThemeProvider } from '../app/theme/ThemeProvider'
import type { ElysianGateway } from '../contracts/adapters'

/**
 * 测试统一从这里渲染整棵应用树，provider 结构与 App 一致。
 * 传入 gateway 即可在唯一的适配接缝上替换数据来源。
 * 返回 router，便于断言地址（筛选条件）是否与预期一致。
 */
export function renderApp(path = '/', options: { gateway?: ElysianGateway } = {}) {
  const router = createAppRouter([path])
  const view = render(
    <ThemeProvider>
      <Tooltip.Provider delayDuration={0}>
        <GatewayProvider gateway={options.gateway}>
          <RouterProvider router={router} />
        </GatewayProvider>
      </Tooltip.Provider>
    </ThemeProvider>,
  )
  return { ...view, router }
}
