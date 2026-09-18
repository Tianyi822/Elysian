import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

/** 生产构建专用：不引用含 bun:sqlite 的 dev 中间件链。 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    'import.meta.env.ELSYIAN_DOCKER': JSON.stringify(process.env.ELSYIAN_DOCKER ?? ''),
  },
})
