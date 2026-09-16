import test from 'node:test'
import assert from 'node:assert/strict'

import { ExitAllocator } from '../../src/main/egress/allocation.ts'
import type { EgressExit } from '../../src/main/egress/types.ts'

function exit(id: string): EgressExit {
  return { id, protocol: 'http', host: '127.0.0.1', port: 8000 }
}

test('allocator walks the pool and advances the cursor', () => {
  const allocator = new ExitAllocator()
  const pool = [exit('a'), exit('b'), exit('c')]

  assert.equal(allocator.allocate(pool)?.id, 'a')
  assert.equal(allocator.allocate(pool)?.id, 'b')
  assert.equal(allocator.allocate(pool)?.id, 'c')
})

test('allocator never returns the exit just released while others are free', () => {
  const allocator = new ExitAllocator()
  const pool = [exit('a'), exit('b'), exit('c')]

  assert.equal(allocator.allocate(pool)?.id, 'a')
  allocator.release('a')
  const next = allocator.allocate(pool)
  assert.notEqual(next?.id, 'a')
  assert.equal(next?.id, 'b')
})

test('allocator skips exits currently held by another group', () => {
  const allocator = new ExitAllocator()
  const pool = [exit('a'), exit('b'), exit('c')]

  assert.equal(allocator.allocate(pool)?.id, 'a')
  assert.equal(allocator.allocate(pool)?.id, 'b')
  // 'a' and 'b' are held; the next allocation must land on 'c'.
  assert.equal(allocator.allocate(pool)?.id, 'c')
})

test('allocator wraps around and reuses exits once the pool is saturated', () => {
  const allocator = new ExitAllocator()
  const pool = [exit('a'), exit('b')]

  assert.equal(allocator.allocate(pool)?.id, 'a')
  assert.equal(allocator.allocate(pool)?.id, 'b')
  // Saturated: wrapping reuse is allowed.
  assert.equal(allocator.allocate(pool)?.id, 'a')
  assert.equal(allocator.allocate(pool)?.id, 'b')
})

test('allocator returns null for an empty pool', () => {
  const allocator = new ExitAllocator()
  assert.equal(allocator.allocate([]), null)
})

test('allocator exposes cursor position and in-use tracking', () => {
  const allocator = new ExitAllocator()
  assert.equal(allocator.position(), 0)

  allocator.setPosition(2)
  assert.equal(allocator.position(), 2)

  allocator.markInUse('a')
  assert.equal(allocator.isInUse('a'), true)
  assert.equal(allocator.isInUse('b'), false)

  allocator.release('a')
  assert.equal(allocator.isInUse('a'), false)
})
