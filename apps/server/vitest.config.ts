import { defineConfig } from 'vitest/config'

/*
 * server 侧 Vitest 配置：node 环境，守卫与路由测试用 Hono 的 app.request 驱动，
 * 不起真实监听。*.bun.test.ts 依赖 Bun 运行时（bun:sqlite），vitest 不收集；
 * 迁入这类文件时在 package.json 的 test 脚本里用 bun test 显式点名执行。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['**/*.bun.test.ts'],
  },
})
