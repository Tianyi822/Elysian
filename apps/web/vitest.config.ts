import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vitest/config'

/** Vitest 专用配置：不加载含 bun:sqlite 的 dev 中间件插件。 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    'import.meta.env.ELSYIAN_DOCKER': JSON.stringify(process.env.ELSYIAN_DOCKER ?? ''),
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['**/*.bun.test.ts'],
  },
})
