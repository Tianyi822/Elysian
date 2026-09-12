import * as Tooltip from '@radix-ui/react-tooltip'
import { render } from '@testing-library/react'
import { RouterProvider } from 'react-router'
import { createAppRouter } from '../app/router'
import { ThemeProvider } from '../app/theme/ThemeProvider'

/**
 * 测试统一从这里渲染整棵应用树，保证 provider 结构与 App 一致，
 * 避免测试与真实挂载之间的差异成为盲区。
 */
export function renderApp(path = '/') {
  return render(
    <ThemeProvider>
      <Tooltip.Provider delayDuration={0}>
        <RouterProvider router={createAppRouter([path])} />
      </Tooltip.Provider>
    </ThemeProvider>,
  )
}
