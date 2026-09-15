import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vitest/config'
// 配置文件会被 Node 直接加载（Vite 计划把 configLoader 默认改为 native），
// 这条依赖图里的相对导入一律带 .ts 扩展名，与 @elysian/contracts 包同例。
import { mockEventsPlugin } from './src/adapters/sse/mockEventsPlugin.ts'

export default defineConfig({
  // dev 与 preview 都由同一个插件提供 mock 事件流端点 GET /api/events。
  plugins: [react(), tailwindcss(), mockEventsPlugin()],
  server: { port: 5173 },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
