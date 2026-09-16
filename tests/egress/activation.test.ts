import test from 'node:test'
import assert from 'node:assert/strict'

import { EgressManager } from '../../src/main/egress/manager.ts'
import type { EgressManagerDeps, OutboundProxySettings } from '../../src/main/egress/manager.ts'
import type { EgressExit, EgressSource } from '../../src/main/egress/types.ts'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function makeSettings(overrides: Partial<OutboundProxySettings> = {}): OutboundProxySettings {
  return {
    enabled: true,
    groupAssignmentEnabled: false,
    activeSourceId: 's1',
    rotation: { strategy: 'roundRobin', rotateEarlySeconds: 30, verifyBeforeUse: false },
    sources: [{ id: 's1', sourceId: 'config-file', settings: {} }],
    groups: [],
    ...overrides,
  }
}

function makeDeps(settings: OutboundProxySettings, assignment: Record<string, string> = {}) {
  return {
    getSettings: () => settings,
    getProviderAssignment: () => assignment,
    getAccountIds: () => Object.keys(assignment),
    listProviderIds: () => ['p1'],
    getProviderName: () => 'P',
    logger: { info: () => {}, warn: () => {} },
  } satisfies EgressManagerDeps
}

function exit(id: string): EgressExit {
  return { id, name: id, protocol: 'http', host: '127.0.0.1', port: 8000 }
}

function stubSource(
  source: EgressSource,
  manager: EgressManager,
): { probe: number; apply: number; listExits: number } {
  const calls = { probe: 0, apply: 0, listExits: 0 }
  const wrapped: EgressSource = {
    meta: source.meta,
    probe: async () => {
      calls.probe += 1
      return source.probe()
    },
    listExits: async () => {
      calls.listExits += 1
      return source.listExits()
    },
    apply: async (e) => {
      calls.apply += 1
      return source.apply(e)
    },
    deactivate: () => source.deactivate(),
  }
  ;(manager as unknown as { getActiveSource: () => EgressSource }).getActiveSource = () => wrapped
  return calls
}

function fakeSource(overrides: Partial<EgressSource> = {}): EgressSource {
  return {
    meta: {
      id: 'config-file',
      labelKey: 'x',
      fields: [],
      capabilities: { rotate: true, listExits: true, expiry: false, alwaysOn: true },
    },
    probe: async () => ({ available: true }),
    listExits: async () => [exit('a'), exit('b')],
    apply: async () => true,
    deactivate: async () => {},
    ...overrides,
  }
}

test('concurrent activation is single-flight (one probe, one result)', async () => {
  const manager = new EgressManager()
  manager.setDeps(makeDeps(makeSettings()))
  const calls = stubSource(
    fakeSource({
      probe: async () => {
        await delay(20)
        return { available: true }
      },
    }),
    manager,
  )

  const results = await Promise.all([
    manager.ensureProxyForRequest(),
    manager.ensureProxyForRequest(),
    manager.ensureProxyForRequest(),
  ])
  assert.deepEqual(results, [true, true, true])
  assert.equal(calls.probe, 1)
  assert.equal(manager.isProxyMode(), true)
})

test('failed activation sets a cooldown that suppresses immediate retries', async () => {
  const manager = new EgressManager()
  manager.setDeps(makeDeps(makeSettings()))
  const calls = stubSource(
    fakeSource({ probe: async () => ({ available: false, error: 'down' }) }),
    manager,
  )

  assert.equal(await manager.ensureProxyForRequest(), false)
  assert.equal(await manager.ensureProxyForRequest(), false)
  assert.equal(calls.probe, 1)
})

test('invalidation during activation discards the in-flight result', async () => {
  const manager = new EgressManager()
  manager.setDeps(makeDeps(makeSettings()))
  stubSource(
    fakeSource({
      probe: async () => {
        await delay(30)
        return { available: true }
      },
    }),
    manager,
  )

  const pending = manager.ensureProxyForRequest()
  await delay(5)
  manager.invalidateSource()
  assert.equal(await pending, false)
  assert.equal(manager.isProxyMode(), false)
})

test('per-group allocation is single-flight (one exit per group)', async () => {
  const manager = new EgressManager()
  manager.setDeps(makeDeps(makeSettings({ groupAssignmentEnabled: true }), { a1: 'g1' }))
  const calls = stubSource(fakeSource(), manager)

  const [first, second] = await Promise.all([
    manager.resolveExitForAccount('p1', 'a1'),
    manager.resolveExitForAccount('p1', 'a1'),
  ])
  assert.ok(first)
  assert.equal(first, second)
  const inUse = (
    manager as unknown as { allocator: { getInUse: () => string[] } }
  ).allocator.getInUse()
  assert.equal(inUse.length, 1)
  assert.equal(calls.apply, 1)
})
