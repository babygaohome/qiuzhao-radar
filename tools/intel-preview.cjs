#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { runIngestion, MemoryStore, SOURCES } = require('../cloudfunctions/intelCrawler/core')

const fixtures = {
  'huggingface/transformers': [{ id: 1001, name: 'Transformers preview release', tag_name: 'v0.1', html_url: 'https://github.com/huggingface/transformers/releases/tag/v0.1', published_at: '2026-10-01T00:00:00Z' }],
  'chipsalliance/chisel': [{ id: 2001, name: 'Chisel preview release', tag_name: 'v0.1', html_url: 'https://github.com/chipsalliance/chisel/releases/tag/v0.1', published_at: null }]
}

async function main (args = process.argv.slice(2)) {
  const live = args.includes('--live')
  const outputFlag = args.indexOf('--output')
  const output = outputFlag >= 0 ? args[outputFlag + 1] : null
  if (outputFlag >= 0 && (!output || output.startsWith('-'))) throw new Error('--output requires a path')
  const store = new MemoryStore()
  const result = await runIngestion({ store, sources: SOURCES.slice(0, 2), fetchJson: async (url, source) => {
    if (!live) return fixtures[`${source.owner}/${source.repo}`]
    const { requestJson } = require('../cloudfunctions/intelCrawler/core')
    return requestJson(url)
  } })
  const artifact = { mode: live ? 'live_metadata_dry_run' : 'fixture', result, items: Array.from(store.items.values()) }
  const json = JSON.stringify(artifact, null, 2)
  if (output) fs.writeFileSync(path.resolve(output), `${json}\n`, { mode: 0o600 })
  else process.stdout.write(`${json}\n`)
  return result.status === 'success' ? 0 : 1
}

if (require.main === module) main().then(code => { process.exitCode = code }).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
module.exports = { main, fixtures }
