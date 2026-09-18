import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { elysianEventsVitePlugin } from './src/adapters/sse/mockEventsPlugin.vite.ts'

export default defineConfig({
  plugins: [react(), tailwindcss(), elysianEventsVitePlugin()],
  define: {
    'import.meta.env.ELSYIAN_DOCKER': JSON.stringify(process.env.ELSYIAN_DOCKER ?? ''),
  },
  server: {
    port: 5173,
    host: true,
    watch: process.env.ELSYIAN_DOCKER === '1' ? { usePolling: true } : undefined,
  },
})
