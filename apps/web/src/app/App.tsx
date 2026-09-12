import * as Tooltip from '@radix-ui/react-tooltip'
import { RouterProvider } from 'react-router'
import { browserRouter } from './router'
import { ThemeProvider } from './theme/ThemeProvider'

export function App() {
  return (
    <ThemeProvider>
      <Tooltip.Provider delayDuration={400}>
        <RouterProvider router={browserRouter} />
      </Tooltip.Provider>
    </ThemeProvider>
  )
}
