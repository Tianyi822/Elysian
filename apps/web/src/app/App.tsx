import * as Tooltip from '@radix-ui/react-tooltip'
import { RouterProvider } from 'react-router'
import { GatewayProvider } from '../adapters/GatewayProvider'
import { browserRouter } from './router'
import { ThemeProvider } from './theme/ThemeProvider'

export function App() {
  return (
    <ThemeProvider>
      <Tooltip.Provider delayDuration={400}>
        <GatewayProvider>
          <RouterProvider router={browserRouter} />
        </GatewayProvider>
      </Tooltip.Provider>
    </ThemeProvider>
  )
}
