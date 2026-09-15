/**
 * Builds the FluxMeld web/server distribution:
 *   1. vite build  -> out/renderer  (React SPA)
 *   2. esbuild     -> out/server/__bridge.js  (browser electronAPI shim)
 *   3. esbuild     -> out/server/index.cjs    (headless Node server, electron aliased)
 */

import { build as esbuild } from 'esbuild'
import { build as viteBuild } from 'vite'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { existsSync, renameSync } from 'node:fs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outServer = join(root, 'out', 'server')

const electronAliasPlugin = {
  name: 'fluxmeld-electron-alias',
  setup(build) {
    const aliases = {
      electron: join(root, 'src', 'server', 'stubs', 'electron.ts'),
      'electron-store': join(root, 'src', 'server', 'stubs', 'electron-store.ts'),
      'electron-updater': join(root, 'src', 'server', 'stubs', 'electron-updater.ts'),
    }

    build.onResolve({ filter: /^(electron|electron-store|electron-updater)$/ }, (args) => {
      const target = aliases[args.path]
      return target ? { path: target } : null
    })
  },
}

async function main() {
  console.log('[web:build] 1/3 building renderer...')
  await viteBuild({ configFile: join(root, 'vite.web.config.ts') })

  console.log('[web:build] 2/3 building browser bridge...')
  await esbuild({
    entryPoints: [join(root, 'src', 'web', 'bridge.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2020'],
    outfile: join(outServer, '__bridge.js'),
    logLevel: 'warning',
  })

  console.log('[web:build] 3/3 building headless server...')
  const serverOut = join(outServer, 'index.cjs')
  await esbuild({
    entryPoints: [join(root, 'src', 'server', 'index.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: ['node20'],
    outfile: serverOut,
    plugins: [electronAliasPlugin],
    external: ['zstd-codec', 'canvas'],
    sourcemap: true,
    logLevel: 'info',
  })

  // Best-effort: normalize the index.js alias if a tool emitted it.
  const altOut = join(outServer, 'index.js')
  if (!existsSync(serverOut) && existsSync(altOut)) {
    renameSync(altOut, serverOut)
  }

  console.log('[web:build] done. Start with: npm run web:start')
}

main().catch((error) => {
  console.error('[web:build] failed:', error)
  process.exit(1)
})
