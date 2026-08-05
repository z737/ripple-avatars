import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // .glsl files are imported with `?raw`, which Vite handles natively —
  // no shader plugin needed.
  assetsInclude: ['**/*.glsl'],
})
