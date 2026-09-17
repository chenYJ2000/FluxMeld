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

function makeSettings(): OutboundProxySettings {
  return {
    enabled: true,
    groupAssignmentEnabled: false,
    activeSourceId: 's1',
    rotation: rotationWith(),
    sources: [{ id: 's1', sourceId: 'netfountain', settings: {} }],
    groups: [],
  }
}

function makeDeps(settings: OutboundProxySettings): EgressManagerDeps {
  return {
    getSettings: () => settings,
    getProviderAssignment: () => ({}),
    getAccountIds: () => [],
    listProviderIds: () => [],
    getProviderName: () => 'P',
    logger: { info: () => {}, warn: () => {} },
  }
}

function leaseSource() {
  const acquired: EgressExit[] = []
  const disposed: string[] = []
  let deactivated = 0
  let counter = 0
  const source: EgressSource = {
    meta: META,
    probe: async () => ({ available: true }),
    listExits: async () => [...acquired],
    apply: async () => true,
    deactivate: async () => {
      deactivated += 1
    },
    acquireExit: async () => {
      counter += 1
      const exit: EgressExit = {
        id: `ip-${counter}`,
        name: `ip-${counter}`,
        protocol: 'http',
        host: '1.2.3.4',
        port: 8000 + counter,
      }
      acquired.push(exit)
      return exit
    },
    disposeExit: async (exit) => {
      disposed.push(exit.id)
    },
  }
  return { source, acquired, disposed, getDeactivated: () => deactivated }
}

function installSource(manager: EgressManager, source: EgressSource): void {
  const internal = manager as unknown as {
    getActiveSource: () => EgressSource
    activeSource: EgressSource | null
  }
  internal.getActiveSource = () => source
  internal.activeSource = source
}

test('leased source acquires on enable and disposes the old IP on rotation', async () => {
  const manager = new EgressManager()
  const fake = leaseSource()
  installSource(manager, fake.source)
  manager.setDeps(makeDeps(makeSettings()))

  const enabled = await manager.enable()
  assert.equal(enabled.success, true)
  assert.equal(manager.getActiveExit()?.id, 'ip-1')

  const rotated = await manager.rotateProxy()
  assert.equal(rotated, 'ip-2')
  assert.deepEqual(fake.disposed, ['ip-1'])
  assert.equal(manager.getActiveExit()?.id, 'ip-2')

  await manager.disable()
  assert.equal(fake.getDeactivated(), 1)
})

test('leased source reports its held exits through getExits', async () => {
  const manager = new EgressManager()
  const fake = leaseSource()
  installSource(manager, fake.source)
  manager.setDeps(makeDeps(makeSettings()))

  await manager.enable()
  const exits = await manager.getExits()
  assert.deepEqual(
    exits.map((exit) => exit.id),
    ['ip-1'],
  )
})

test('enable fails when the leased source cannot acquire an exit', async () => {
  const manager = new EgressManager()
  const source: EgressSource = {
    meta: META,
    probe: async () => ({ available: true }),
    listExits: async () => [],
    apply: async () => true,
    deactivate: async () => {},
    acquireExit: async () => null,
    disposeExit: async () => {},
  }
  installSource(manager, source)
  manager.setDeps(makeDeps(makeSettings()))

  const result = await manager.enable()
  assert.equal(result.success, false)
  assert.equal(manager.getActiveExit(), null)
})
