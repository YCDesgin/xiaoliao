import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  // GitHub Pages 子路径；本地 dev 不受影响（默认 '/'）。
  // 部署时在 CI 中设 GITHUB_PAGES=true 即可。
  base: process.env.GITHUB_PAGES === 'true' ? '/xiaoliao/' : '/',
  plugins: [react(), tailwindcss()],
})
