import test from 'node:test'
import assert from 'node:assert/strict'

import { EgressManager } from '../../src/main/egress/manager.ts'
import type { EgressManagerDeps, OutboundProxySettings } from '../../src/main/egress/manager.ts'
import type {
  EgressExit,
  EgressSource,
  EgressSourceModuleMeta,
} from '../../src/main/egress/types.ts'
import type { RotationPolicy } from '../../src/shared/types.ts'

const META: EgressSourceModuleMeta = {
  id: 'netfountain',
  labelKey: 'test.netfountain',
  fields: [],
  capabilities: { rotate: true, listExits: true, expiry: true, alwaysOn: true },
  defaultMaxExitAttempts: 3,
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function rotationWith(overrides: Partial<RotationPolicy> = {}): RotationPolicy {
  return {
    strategy: 'roundRobin',
    rotateEarlySeconds: 0,
    verifyBeforeUse: false,
    verifyTimeoutMs: 2000,
    maxExitAttempts: 0,
    rotateAfterFailures: 1,
    rotateMinIntervalMs: 0,
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
    sources: [{ id: 's1', sourceId: 'netfountain', settings: {} }],
    groups: [],
    ...overrides,
  }
}

function makeDeps(
  settings: OutboundProxySettings,
  assignment: Record<string, string | null> = {},
): EgressManagerDeps {
  return {
    getSettings: () => settings,
    getProviderAssignment: () => assignment,
    getAccountIds: () => Object.keys(assignment),
    listProviderIds: () => ['p1'],
    getProviderName: () => 'P',
    logger: { info: () => {}, warn: () => {} },
  }
}

/** A source whose `acquireExit` blocks until the test releases its gate. */
function controlledSource() {
  const disposed: string[] = []
  const gates: Array<{ release: () => void }> = []
  let acquireCalls = 0
  let issued = 0

  const source: EgressSource = {
    meta: META,
    probe: async () => ({ available: true }),
    listExits: async () => [],
    apply: async () => true,
    deactivate: async () => {},
    acquireExit: async (): Promise<EgressExit> => {
      acquireCalls += 1
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      gates.push({ release: () => release() })
      await gate
      issued += 1
      return {
        id: `ip-${issued}`,
        name: `ip-${issued}`,
        protocol: 'http',
        host: '1.2.3.4',
        port: 8000 + issued,
      }
    },
    disposeExit: async (exit) => {
      disposed.push(exit.id)
    },
  }

  return { source, disposed, gates, getAcquireCalls: () => acquireCalls }
}

function installSource(manager: EgressManager, source: EgressSource): void {
  const internal = manager as unknown as {
    getActiveSource: () => EgressSource
    activeSource: EgressSource | null
  }
  internal.getActiveSource = () => source
  internal.activeSource = source
}

test('global: a request during rotation waits instead of acquiring a second IP', async () => {
  const manager = new EgressManager()
  const fake = controlledSource()
  installSource(manager, fake.source)
  manager.setDeps(makeDeps(makeSettings()))

  const enabling = manager.enable()
  await flush()
  assert.equal(fake.getAcquireCalls(), 1)
  fake.gates[0].release()
  await enabling
  assert.equal(manager.getActiveExit()?.id, 'ip-1')

  // Threshold 1: the next failure rotates. Rotation blocks on acquireExit.
  const rotating = manager.noteProxyFailure()
  await flush()
  assert.equal(fake.getAcquireCalls(), 2)

  // A concurrent request arrives while the global exit is transiently absent.
  const request = manager.resolveExitForAccount('p1', 'a')
  await flush()
  assert.equal(fake.getAcquireCalls(), 2, 'no second acquire during rotation')

  fake.gates[1].release()
  assert.equal(await rotating, 'ip-2')
  assert.equal((await request)?.id, 'ip-2')
  assert.equal(fake.getAcquireCalls(), 2)
  assert.deepEqual(fake.disposed, ['ip-1'])
})

test('group: a request during rotation waits instead of acquiring a second IP', async () => {
  const manager = new EgressManager()
  const fake = controlledSource()
  installSource(manager, fake.source)
  const settings = makeSettings({
    groupAssignmentEnabled: true,
    groups: [{ id: 'g1', name: 'G1' }],
  })
  manager.setDeps(makeDeps(settings, { a1: 'g1' }))

  const warming = manager.warmGroupExits()
  await flush()
  assert.equal(fake.getAcquireCalls(), 1)
  fake.gates[0].release()
  await warming
  assert.equal(manager.getAssignmentOverview('p1').groupExits.g1?.id, 'ip-1')

  const rotating = manager.noteGroupFailure('g1')
  await flush()
  assert.equal(fake.getAcquireCalls(), 2)

  const request = manager.resolveExitForAccount('p1', 'a1')
  await flush()
  assert.equal(fake.getAcquireCalls(), 2, 'no second acquire during rotation')

  fake.gates[1].release()
  assert.equal(await rotating, 'ip-2')
  assert.equal((await request)?.id, 'ip-2')
  assert.equal(fake.getAcquireCalls(), 2)
  assert.deepEqual(fake.disposed, ['ip-1'])
})

test('group: rotation waits for an ensure that started first', async () => {
  const manager = new EgressManager()
  const fake = controlledSource()
  installSource(manager, fake.source)
  const settings = makeSettings({
    groupAssignmentEnabled: true,
    groups: [{ id: 'g1', name: 'G1' }],
  })
  manager.setDeps(makeDeps(settings, { a1: 'g1' }))

  // A request triggers the first acquisition (blocked on the gate).
  const request = manager.resolveExitForAccount('p1', 'a1')
  await flush()
  assert.equal(fake.getAcquireCalls(), 1)

  // A rotation arrives while that ensure is still in flight.
  const rotating = manager.noteGroupFailure('g1')
  await flush()
  assert.equal(fake.getAcquireCalls(), 1, 'rotation does not acquire while ensure is running')

  fake.gates[0].release()
  assert.equal((await request)?.id, 'ip-1')

  // Rotation proceeds afterwards: disposes ip-1 and acquires ip-2.
  await flush()
  assert.equal(fake.getAcquireCalls(), 2)
  fake.gates[1].release()
  assert.equal(await rotating, 'ip-2')
  assert.equal(fake.getAcquireCalls(), 2)
  assert.deepEqual(fake.disposed, ['ip-1'])
  assert.equal(manager.getAssignmentOverview('p1').groupExits.g1?.id, 'ip-2')
})
