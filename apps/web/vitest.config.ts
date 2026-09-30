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
    // 共享宿主机高负载时，重型 jsdom 用例会被误判为超时（基线 HEAD 在 load 40+ 下
    // 同样大面积超时），先后从默认 5s 放宽到 15s、再到 30s：全量跑实测 worker 池
    // （10 fork）叠加上宿主外部负载时会出现 60~90s 的饥饿窗口，窗口内整棵渲染的
    // 重型用例放大 12~18 倍（单测实测 18.4s），15s 预算被击穿且断言从未失败。
    // 30s 只放宽等待预算，断言不受影响；逻辑性失败仍由 waitFor（5s）先拦住。
    testTimeout: 30_000,
  },
})
