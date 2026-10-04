import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  server: { host: true, hmr: process.env.NO_HMR ? false : undefined },
  build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
})
