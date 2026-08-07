#!/usr/bin/env node
/**
 * Copy non-TypeScript runtime assets into the build output.
 *
 * `tsc` emits only what it compiles, so the industry snapshot JSON files would
 * be absent from `dist` and `loadSnapshots()` would find an empty directory in
 * production. That failure is silent — an operator sees an onboarding wizard
 * offering zero verticals and has no reason to suspect a build step.
 *
 * Keeping the snapshots as loose JSON read at runtime, rather than importing
 * them as modules, is deliberate: it preserves the property the specification
 * asks for, that adding a vertical is a JSON file rather than a code change.
 * This script is the cost of that.
 */
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const serverRoot = dirname(dirname(fileURLToPath(import.meta.url)))

const assetDirectories = [
  'src/services/snapshots/definitions',
]

let copied = 0
for (const relative of assetDirectories) {
  const from = join(serverRoot, relative)
  const to = join(serverRoot, 'dist', relative)
  if (!existsSync(from)) {
    console.error(`copy-assets: source directory missing: ${relative}`)
    process.exit(1)
  }
  mkdirSync(to, { recursive: true })
  cpSync(from, to, { recursive: true })
  copied += readdirSync(from).filter((file) => file.endsWith('.json')).length
}

if (copied === 0) {
  // An empty snapshot set is almost certainly a mistake rather than a choice,
  // and it fails silently at runtime. Fail here instead.
  console.error('copy-assets: no snapshot definitions were found to copy')
  process.exit(1)
}

console.log(`copy-assets: copied ${copied} runtime asset file(s) into dist.`)
