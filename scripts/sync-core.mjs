#!/usr/bin/env node
/**
 * Refresh the bundled core, renderer, fixture and license from an agent-blackbox
 * checkout. The published plugin is self-contained; this script is only for
 * maintainers updating the bundle when the main project changes.
 *
 * Usage:
 *   node scripts/sync-core.mjs [--from ../agent-blackbox]
 */
import { cpSync, existsSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const fromIndex = process.argv.indexOf('--from')
const source = resolve(ROOT, fromIndex >= 0 ? process.argv[fromIndex + 1] : '../agent-blackbox')

for (const required of ['dist/server.js', 'web/index.html', 'fixtures/mission-demo.ndjson', 'LICENSE']) {
  if (!existsSync(join(source, required))) {
    throw new Error(`${source} does not look like an agent-blackbox checkout: missing ${required}`)
  }
}

rmSync(join(ROOT, 'core'), { recursive: true, force: true })
cpSync(join(source, 'dist'), join(ROOT, 'core'), { recursive: true })
rmSync(join(ROOT, 'web'), { recursive: true, force: true })
cpSync(join(source, 'web'), join(ROOT, 'web'), { recursive: true })
rmSync(join(ROOT, 'fixtures'), { recursive: true, force: true })
cpSync(join(source, 'fixtures', 'mission-demo.ndjson'), join(ROOT, 'fixtures', 'mission-demo.ndjson'))
cpSync(join(source, 'LICENSE'), join(ROOT, 'LICENSE'))
process.stdout.write(`synced core, web, fixture and license from ${source}\n`)
