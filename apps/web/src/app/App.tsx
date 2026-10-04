import * as Tooltip from '@radix-ui/react-tooltip'
import { RouterProvider } from 'react-router'
import { GatewayProvider } from '../adapters/GatewayProvider'
import { browserRouter } from './router'
import { ThemeProvider } from './theme/ThemeProvider'

export function App() {
  return (
    <ThemeProvider>
      {/* 折叠侧栏里图标是唯一线索，提示要来得快：400ms 会被当成「没有提示」。 */}
      <Tooltip.Provider delayDuration={150}>
        <GatewayProvider>
          <RouterProvider router={browserRouter} />
        </GatewayProvider>
      </Tooltip.Provider>
    </ThemeProvider>
  )
}
