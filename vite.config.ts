import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'

const rev = (() => {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim()
  } catch {
    return 'dev'
  }
})()

export default defineConfig({
  base: './',
  define: { __BUILD__: JSON.stringify(`${rev} ${new Date().toISOString().slice(0, 16)}Z`) },
  server: { host: true, hmr: process.env.NO_HMR ? false : undefined },
  build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
})
