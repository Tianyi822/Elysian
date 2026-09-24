import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vitest/config'

/** Vitest 专用配置：不加载含 bun:sqlite 的 dev 中间件插件。 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    'import.meta.env.ELYSIAN_DOCKER': JSON.stringify(process.env.ELYSIAN_DOCKER ?? ''),
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['**/*.bun.test.ts'],
    // 共享宿主机高负载时，重型 jsdom 用例会跑过 Vitest 默认的 5s 预算被误判为超时
    // （基线 HEAD 在 load 40+ 下同样大面积超时）。15s 仍足以拦住真挂起，断言不受影响。
    testTimeout: 15_000,
  },
})
