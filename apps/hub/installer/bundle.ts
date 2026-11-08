import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

// The hub as the register PC runs it (task 1.13): `hub.mjs` (the service) and `reset.mjs` (a new
// admin password) as single files, with their dependencies inside, for the Node that ships with
// the installer. The packages are TypeScript source, so they are bundled here, not compiled apart.

const source = (file: string) => fileURLToPath(new URL(`../src/${file}`, import.meta.url))

export const ENTRIES = { hub: source('main.ts'), reset: source('reset.ts') }

export async function bundleHub(outDir: string): Promise<void> {
  await build({
    entryPoints: ENTRIES,
    outdir: outDir,
    outExtension: { '.js': '.mjs' },
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    // Some dependencies are CommonJS and call `require` for Node's own modules.
    banner: {
      js: "import { createRequire as faroRequire } from 'node:module'; const require = faroRequire(import.meta.url);",
    },
    // Optional speedups of `ws` that it loads only if present.
    external: ['bufferutil', 'utf-8-validate'],
    // Readable stack traces in the service log.
    sourcemap: 'linked',
    legalComments: 'external',
    logLevel: 'warning',
  })
}
