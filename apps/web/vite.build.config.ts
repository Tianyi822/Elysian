import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

/** 生产构建专用：不引用含 bun:sqlite 的 dev 中间件链。 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // 路由和终端库按需加载；静态资源由 Go 单二进制内嵌，保留单块大小警告。
    chunkSizeWarningLimit: 700,
    rolldownOptions: {
      // jquery.terminal 解析扩展命令参数的内部 eval（jquery.terminal.js:7022）：CommandTerminal
      // 已用 escape_brackets 转义全部方括号并关闭 invokeMethods/exec，该求值路径运行时不可达；
      // 项目约定不维护第三方补丁，构建期按来源压制这条警告。
      onLog(level, log, defaultHandler) {
        if (log.code === 'EVAL' && log.id?.includes('jquery.terminal')) return
        defaultHandler(level, log)
      },
      output: {
        // 聊天/Wiki 的语法高亮独立为异步块，登录页不下载。
        advancedChunks: {
          groups: [
            { name: 'highlight', test: /node_modules[\\/](?:highlight\.js|lowlight)[\\/]/ },
          ],
        },
      },
    },
  },
  define: {
    'import.meta.env.ELYSIAN_BUILD_COMMIT': JSON.stringify(process.env.ELYSIAN_BUILD_COMMIT ?? ''),
    'import.meta.env.ELYSIAN_DOCKER': JSON.stringify(process.env.ELYSIAN_DOCKER ?? ''),
  },
})
