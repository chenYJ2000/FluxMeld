import test from 'node:test'
import assert from 'node:assert/strict'

import { EgressManager, DIRECT_GROUP } from '../../src/main/egress/manager.ts'
import type { EgressManagerDeps, OutboundProxySettings } from '../../src/main/egress/manager.ts'

function makeDeps(options: {
  groups: Array<{ id: string; name: string }>
  accounts: Record<string, string[]>
  assignments: Record<string, Record<string, string | null>>
}): EgressManagerDeps {
  const settings: OutboundProxySettings = {
    enabled: true,
    groupAssignmentEnabled: true,
    activeSourceId: '',
    rotation: {
      strategy: 'roundRobin',
      rotateEarlySeconds: 30,
      verifyBeforeUse: false,
      verifyTimeoutMs: 5000,
      maxExitAttempts: 8,
      rotateMinIntervalMs: 3000,
      cooldownBaseMs: 1000,
      cooldownMaxMs: 30000,
    },
    sources: [],
    groups: options.groups,
  }
  return {
    getSettings: () => settings,
    getProviderAssignment: (providerId) => options.assignments[providerId],
    getAccountIds: (providerId) => options.accounts[providerId] ?? [],
    listProviderIds: () => Object.keys(options.accounts),
    getProviderName: () => 'P',
    logger: { info: () => {}, warn: () => {} },
  }
}

test('auto assign fills existing groups then creates new ones', () => {
  const manager = new EgressManager()
  const accounts = Array.from({ length: 25 }, (_, i) => `a${i}`)
  manager.setDeps(
    makeDeps({
      groups: [
        { id: 'g1', name: 'G1' },
        { id: 'g2', name: 'G2' },
      ],
      accounts: { p1: accounts },
      assignments: {},
    }),
  )

  return manager.autoAssign('p1', 10, 'provider').then(({ assignment, groups }) => {
    const g1 = accounts.filter((id) => assignment[id] === 'g1').length
    const g2 = accounts.filter((id) => assignment[id] === 'g2').length
    assert.equal(g1, 10)
    assert.equal(g2, 10)
    assert.equal(groups.length, 3)
    const g3 = groups[2].id
    assert.equal(accounts.filter((id) => assignment[id] === g3).length, 5)
  })
})

test('auto assign leaves already assigned accounts untouched', () => {
  const manager = new EgressManager()
  const accounts = ['a0', 'a1', 'a2', 'a3']
  manager.setDeps(
    makeDeps({
      groups: [{ id: 'g1', name: 'G1' }],
      accounts: { p1: accounts },
      assignments: { p1: { a0: 'g1' } },
    }),
  )

  return manager.autoAssign('p1', 2, 'provider').then(({ assignment }) => {
    assert.equal(assignment.a0, 'g1')
    // a1 fills g1 (limit 2 counts a0), a2/a3 need a new group.
    assert.equal(assignment.a1, 'g1')
    assert.notEqual(assignment.a2, undefined)
    assert.equal(assignment.a2, assignment.a3)
  })
})

test('global scope counts accounts from every provider toward the limit', () => {
  const manager = new EgressManager()
  manager.setDeps(
    makeDeps({
      groups: [{ id: 'g1', name: 'G1' }],
      accounts: { p1: ['a0', 'a1'], p2: ['b0'] },
      assignments: { p2: { b0: 'g1' } },
    }),
  )

  return manager.autoAssign('p1', 1, 'global').then(({ assignment, groups }) => {
    // g1 already holds p2's account and the limit is 1, so p1 gets new groups.
    assert.notEqual(assignment.a0, 'g1')
    assert.equal(groups.length, 3)
  })
})

test('overview reports provider and global group counts', () => {
  const manager = new EgressManager()
  manager.setDeps(
    makeDeps({
      groups: [{ id: 'g1', name: 'G1' }],
      accounts: { p1: ['a0', 'a1', 'a2'], p2: ['b0', 'b1'] },
      assignments: { p1: { a0: 'g1' }, p2: { b0: 'g1', b1: 'g1' } },
    }),
  )

  const overview = manager.getAssignmentOverview('p1')
  assert.equal(overview.providerTotals.total, 3)
  assert.equal(overview.providerTotals.byGroup.g1, 1)
  assert.equal(overview.providerTotals.byGroup[DIRECT_GROUP], 2)
  assert.equal(overview.globalTotals.total, 5)
  assert.equal(overview.globalTotals.byGroup.g1, 3)
})
