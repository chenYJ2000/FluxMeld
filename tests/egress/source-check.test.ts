import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EgressManager } from '../../src/main/egress/manager.ts'

test('checkSource reports unknown source types', async () => {
  const manager = new EgressManager()
  const result = await manager.checkSource({ id: 'x', sourceId: 'nope', settings: {} })
  assert.equal(result.available, false)
  assert.match(result.error ?? '', /Unknown/)
})

test('config-file check fails when the file is missing', async () => {
  const manager = new EgressManager()
  const result = await manager.checkSource({
    id: 'x',
    sourceId: 'config-file',
    settings: { filePath: join(tmpdir(), 'fluxmeld-missing-file.json') },
  })
  assert.equal(result.available, false)
})

test('config-file check succeeds and reports malformed entries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fluxmeld-egress-'))
  try {
    const file = join(dir, 'good.json')
    writeFileSync(
      file,
      JSON.stringify([
        { host: '1.2.3.4', port: 8080 },
        { host: '', port: 1 },
      ]),
    )
    const manager = new EgressManager()
    const result = await manager.checkSource({
      id: 'x',
      sourceId: 'config-file',
      settings: { filePath: file },
    })
    assert.equal(result.available, true)
    assert.equal(result.details?.exitCount, 1)
    assert.equal(result.details?.skipped, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('config-file check reports an invalid top-level shape', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fluxmeld-egress-'))
  try {
    const file = join(dir, 'bad.json')
    writeFileSync(file, JSON.stringify({ foo: 'bar' }))
    const manager = new EgressManager()
    const result = await manager.checkSource({
      id: 'x',
      sourceId: 'config-file',
      settings: { filePath: file },
    })
    assert.equal(result.available, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
