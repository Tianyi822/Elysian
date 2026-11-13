import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

/** 生产构建专用：不引用含 bun:sqlite 的 dev 中间件链。 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // 路由级懒加载后主入口约 273 kB（gzip 85 kB），登录关键路径含预载共享块约 278 kB gzip；
    // echarts 独立块 647 kB（gzip 220 kB）是按需引入后的固有体积，仅仪表盘异步加载。
    // 静态资源由 Go 单二进制内嵌、gzip + immutable 长缓存伺服；警告线按当前最大块
    // （echarts 647 kB）留余量设 700 kB，单块回归会重新触发提示。
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
        // 仪表盘的 echarts 与聊天/Wiki 的 highlight.js 各自成纯异步块：路由级分割后不再进
        // 主入口与 modulepreload，登录页不下载；两者均为按需引入后的固有体积。
        advancedChunks: {
          groups: [
            { name: 'echarts', test: /node_modules[\\/](?:echarts|zrender)[\\/]/ },
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
