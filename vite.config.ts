import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { atlasServerPlugin } from './src/plugins/atlasServer'
import { prefabServerPlugin } from './src/plugins/prefabServer'
import { unityBridgePlugin } from './src/plugins/unityBridgePlugin'
import { aiNormalizePlugin } from './src/plugins/aiNormalizePlugin'
import { saveServerPlugin } from './src/plugins/saveServer'
import { presenceServerPlugin } from './src/plugins/presenceServer'
import { debugServerPlugin } from './src/plugins/debugServer'
import { workspaceServerPlugin } from './src/plugins/workspaceServer'

export default defineConfig({
  plugins: [react(), tailwindcss(), atlasServerPlugin(), prefabServerPlugin(), unityBridgePlugin(), aiNormalizePlugin(), saveServerPlugin(), presenceServerPlugin(), workspaceServerPlugin(), debugServerPlugin()],
  server: {
    port: 4105,
    strictPort: true,
    host: '0.0.0.0',
    open: true,
  },
})
