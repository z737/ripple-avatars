import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/** GitHub Pages serves this from a subdirectory, so built asset URLs need the
 *  repo name as their base. Applied on build only — in dev the server is at the
 *  root, and a base there would just move the app to a nested path for no
 *  reason. Routing is unaffected either way, since it is hash-based. */
const REPO_BASE = '/ripple-avatars/'

export default defineConfig(({ command }) => ({
  base: command === 'build' ? REPO_BASE : '/',
  plugins: [react()],
  // .glsl files are imported with `?raw`, which Vite handles natively —
  // no shader plugin needed.
  assetsInclude: ['**/*.glsl'],
}))
