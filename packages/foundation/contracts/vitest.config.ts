import { defineConfig } from 'vitest/config'

/** 纯契约测试独立运行，不加载 Web 的插件、DOM 或全局状态。 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
