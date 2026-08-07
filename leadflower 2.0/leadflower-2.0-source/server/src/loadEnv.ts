// server/src/loadEnv.ts
// Lightweight environment loader to ensure `.env` files are read in dev.
// Also exports `loadedEnvPaths` so scripts can print what got loaded.

import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'

export const loadedEnvPaths: string[] = []

function tryLoad(p: string) {
  if (fs.existsSync(p)) {
    dotenv.config({ path: p })
    loadedEnvPaths.push(p)
  }
}

// Project root (zip layout has server/ at projectRoot/server)
const serverDir = path.resolve(__dirname, '..')
const projectRoot = path.resolve(serverDir, '..')

// Load order: project .env, project .env.local, server/.env, server/.env.local
// Later files override earlier ones (last in wins).
tryLoad(path.join(projectRoot, '.env'))
tryLoad(path.join(projectRoot, '.env.local'))
tryLoad(path.join(serverDir, '.env'))
tryLoad(path.join(serverDir, '.env.local'))
