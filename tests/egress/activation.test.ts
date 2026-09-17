import test from 'node:test'
import assert from 'node:assert/strict'

import { EgressManager } from '../../src/main/egress/manager.ts'
import type { EgressManagerDeps, OutboundProxySettings } from '../../src/main/egress/manager.ts'
import type { EgressExit, EgressSource } from '../../src/main/egress/types.ts'
import type { RotationPolicy } from '../../src/shared/types.ts'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function rotationWith(overrides: Partial<RotationPolicy> = {}): RotationPolicy {
  return {
    strategy: 'roundRobin',
    rotateEarlySeconds: 30,
    verifyBeforeUse: false,
    verifyTimeoutMs: 2000,
    maxExitAttempts: 0,
    rotateAfterFailures: 2,
    rotateMinIntervalMs: 3000,
    cooldownBaseMs: 1000,
    cooldownMaxMs: 30000,
    ...overrides,
  }
}

function makeSettings(overrides: Partial<OutboundProxySettings> = {}): OutboundProxySettings {
  return {
    enabled: true,
    groupAssignmentEnabled: false,
    activeSourceId: 's1',
    rotation: rotationWith(),
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
): { probe: number; apply: number; listExits: number; appliedIds: string[] } {
  const calls = { probe: 0, apply: 0, listExits: 0, appliedIds: [] as string[] }
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
      calls.appliedIds.push(e.id)
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
  manager.setDeps(
    makeDeps(
      makeSettings({
        rotation: rotationWith({ cooldownBaseMs: 60000, cooldownMaxMs: 60000 }),
      }),
    ),
  )
  const calls = stubSource(
    fakeSource({ probe: async () => ({ available: false, error: 'down' }) }),
    manager,
  )

  assert.equal(await manager.ensureProxyForRequest(), false)
  assert.equal(await manager.ensureProxyForRequest(), false)
  assert.equal(calls.probe, 1)
})

test('maxExitAttempts caps the number of candidates tried', async () => {
  const manager = new EgressManager()
  manager.setDeps(makeDeps(makeSettings({ rotation: rotationWith({ maxExitAttempts: 3 }) })))
  const candidates = Array.from({ length: 10 }, (_, index) => exit(`n${index}`))
  const calls = stubSource(
    fakeSource({ listExits: async () => candidates, apply: async () => false }),
    manager,
  )

  assert.equal(await manager.ensureProxyForRequest(), false)
  assert.equal(calls.apply, 3)
})

test('dead nodes are skipped without consuming candidate budget', async () => {
  const manager = new EgressManager()
  manager.setDeps(makeDeps(makeSettings({ rotation: rotationWith({ maxExitAttempts: 1 }) })))
  const table: EgressExit[] = [
    { ...exit('dead-1'), alive: false },
    exit('alive-1'),
    exit('alive-2'),
  ]
  const calls = stubSource(
    fakeSource({ listExits: async () => table, apply: async () => false }),
    manager,
  )

  assert.equal(await manager.ensureProxyForRequest(), false)
  assert.deepEqual(calls.appliedIds, ['alive-1'])
})

test('non-selectable entries consume candidate budget without being tried', async () => {
  const manager = new EgressManager()
  manager.setDeps(makeDeps(makeSettings({ rotation: rotationWith({ maxExitAttempts: 1 }) })))
  const table: EgressExit[] = [{ ...exit('group-1'), selectable: false }, exit('alive-1')]
  const calls = stubSource(
    fakeSource({ listExits: async () => table, apply: async () => false }),
    manager,
  )

  assert.equal(await manager.ensureProxyForRequest(), false)
  assert.equal(calls.apply, 0)
})

test("auto budget ('all') scans the whole table", async () => {
  const manager = new EgressManager()
  manager.setDeps(makeDeps(makeSettings({ rotation: rotationWith({ maxExitAttempts: 0 }) })))
  const table = Array.from({ length: 5 }, (_, index) => exit(`n${index}`))
  const calls = stubSource(
    fakeSource({
      meta: { ...fakeSource().meta, defaultMaxExitAttempts: 'all' },
      listExits: async () => table,
      apply: async () => false,
    }),
    manager,
  )

  assert.equal(await manager.ensureProxyForRequest(), false)
  assert.equal(calls.apply, 5)
})

test('auto budget falls back to 10 when the source declares no default', async () => {
  const manager = new EgressManager()
  manager.setDeps(makeDeps(makeSettings({ rotation: rotationWith({ maxExitAttempts: 0 }) })))
  const table = Array.from({ length: 15 }, (_, index) => exit(`n${index}`))
  const calls = stubSource(
    fakeSource({ listExits: async () => table, apply: async () => false }),
    manager,
  )

  assert.equal(await manager.ensureProxyForRequest(), false)
  assert.equal(calls.apply, 10)
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
