import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vitest/config'
import { mockEventsPlugin } from './src/adapters/sse/mockEventsPlugin'

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
