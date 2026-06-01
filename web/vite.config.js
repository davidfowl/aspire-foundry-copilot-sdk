import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const agentUrl = process.env['AGENT_HA_HTTP'] ?? 'http://localhost:8088';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/invocations': {
        target: agentUrl,
        changeOrigin: true,
      },
    },
  },
})
