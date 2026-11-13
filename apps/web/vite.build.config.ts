import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

/** 生产构建专用：不引用含 bun:sqlite 的 dev 中间件链。 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // 主入口承载全部业务路由（未做路由级懒加载，gzip 后约 489 kB）、echarts 独立块
    // 647 kB 是按需引入后的固有体积（gzip 220 kB）；静态资源由 Go 单二进制内嵌并经
    // 本机与内网伺服，rolldown 的 500 kB 默认线针对公网 CDN 场景，按实际构成放宽。
    chunkSizeWarningLimit: 1700,
    rolldownOptions: {
      // jquery.terminal 解析扩展命令参数的内部 eval（jquery.terminal.js:7022）：CommandTerminal
      // 已用 escape_brackets 转义全部方括号并关闭 invokeMethods/exec，该求值路径运行时不可达；
      // 项目约定不维护第三方补丁，构建期按来源压制这条警告。
      onLog(level, log, defaultHandler) {
        if (log.code === 'EVAL' && log.id?.includes('jquery.terminal')) return
        defaultHandler(level, log)
      },
      output: {
        // 首屏仪表盘的 echarts 与聊天的 highlight.js 各自成块：与业务代码分开缓存、
        // 首页与其余路由并行加载；两者均为按需引入后的固有体积，500 kB 提示线不再适用。
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
