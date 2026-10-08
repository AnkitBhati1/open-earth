import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'

export default defineConfig({
  plugins: [react(), viteStaticCopy({ targets: ['Workers', 'ThirdParty', 'Assets', 'Widgets'].map(name => ({ src: `node_modules/cesium/Build/Cesium/${name}/**/*`, dest: `cesium/${name}`, rename: { stripBase: 5 } })) })],
  define: { CESIUM_BASE_URL: JSON.stringify('/cesium/') },
  server: { host: '127.0.0.1', proxy: { '/api': { target: 'http://127.0.0.1:8765' } } },
  build: { chunkSizeWarningLimit: 1600 },
})
