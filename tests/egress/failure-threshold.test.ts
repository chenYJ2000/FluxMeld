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

function rotationWith(overrides: Partial<RotationPolicy> = {}): RotationPolicy {
  return {
    strategy: 'roundRobin',
    rotateEarlySeconds: 0,
    verifyBeforeUse: false,
    verifyTimeoutMs: 2000,
    maxExitAttempts: 0,
    rotateAfterFailures: 2,
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

function leaseSource() {
  const disposed: string[] = []
  let counter = 0
  const source: EgressSource = {
    meta: META,
    probe: async () => ({ available: true }),
    listExits: async () => [],
    apply: async () => true,
    deactivate: async () => {},
    acquireExit: async (): Promise<EgressExit> => {
      counter += 1
      return {
        id: `ip-${counter}`,
        name: `ip-${counter}`,
        protocol: 'http',
        host: '1.2.3.4',
        port: 8000 + counter,
      }
    },
    disposeExit: async (exit) => {
      disposed.push(exit.id)
    },
  }
  return { source, disposed }
}

function installSource(manager: EgressManager, source: EgressSource): void {
  const internal = manager as unknown as {
    getActiveSource: () => EgressSource
    activeSource: EgressSource | null
  }
  internal.getActiveSource = () => source
  internal.activeSource = source
}

test('rotates only after rotateAfterFailures consecutive failures', async () => {
  const manager = new EgressManager()
  const fake = leaseSource()
  installSource(manager, fake.source)
  manager.setDeps(makeDeps(makeSettings()))

  await manager.enable()
  assert.equal(manager.getActiveExit()?.id, 'ip-1')

  await manager.noteProxyFailure()
  assert.equal(manager.getActiveExit()?.id, 'ip-1')
  assert.deepEqual(fake.disposed, [])

  await manager.noteProxyFailure()
  assert.equal(manager.getActiveExit()?.id, 'ip-2')
  assert.deepEqual(fake.disposed, ['ip-1'])
})

test('a successful request resets the consecutive-failure counter', async () => {
  const manager = new EgressManager()
  const fake = leaseSource()
  installSource(manager, fake.source)
  manager.setDeps(makeDeps(makeSettings()))

  await manager.enable()
  await manager.noteProxyFailure()
  manager.noteRequestSuccess('p1', 'acc')
  await manager.noteProxyFailure()

  assert.equal(manager.getActiveExit()?.id, 'ip-1')
  assert.deepEqual(fake.disposed, [])
})

test('rotateAfterFailures <= 1 rotates on the first failure', async () => {
  const manager = new EgressManager()
  const fake = leaseSource()
  installSource(manager, fake.source)
  manager.setDeps(makeDeps(makeSettings({ rotation: rotationWith({ rotateAfterFailures: 1 }) })))

  await manager.enable()
  await manager.noteProxyFailure()

  assert.equal(manager.getActiveExit()?.id, 'ip-2')
  assert.deepEqual(fake.disposed, ['ip-1'])
})

test('group mode tracks consecutive failures independently per group', async () => {
  const manager = new EgressManager()
  const fake = leaseSource()
  installSource(manager, fake.source)
  const settings = makeSettings({
    groupAssignmentEnabled: true,
    groups: [
      { id: 'g1', name: 'G1' },
      { id: 'g2', name: 'G2' },
    ],
  })
  manager.setDeps(makeDeps(settings, { a1: 'g1', a2: 'g2' }))

  await manager.warmGroupExits()
  let exits = manager.getAssignmentOverview('p1').groupExits
  assert.equal(exits.g1?.id, 'ip-1')
  assert.equal(exits.g2?.id, 'ip-2')

  await manager.noteGroupFailure('g1')
  await manager.noteGroupFailure('g2')
  exits = manager.getAssignmentOverview('p1').groupExits
  assert.equal(exits.g1?.id, 'ip-1')
  assert.equal(exits.g2?.id, 'ip-2')

  await manager.noteGroupFailure('g1')
  exits = manager.getAssignmentOverview('p1').groupExits
  assert.equal(exits.g1?.id, 'ip-3')
  assert.equal(exits.g2?.id, 'ip-2')
  assert.deepEqual(fake.disposed, ['ip-1'])
})
