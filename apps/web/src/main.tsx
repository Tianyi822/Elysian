import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import './styles/index.css'

const container = document.getElementById('root')
if (!container) throw new Error('找不到挂载节点 #root，请检查 index.html')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
