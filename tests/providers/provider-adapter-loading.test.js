const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..', '..')

test('IPC handlers dispatch provider capabilities through the registry instead of adapter imports', () => {
  const source = readFileSync(join(root, 'src/main/ipc/handlers.ts'), 'utf8')

  assert.doesNotMatch(source, /await import\('\.\.\/proxy\/adapters\//)
  assert.doesNotMatch(source, /from '\.\.\/proxy\/adapters\//)
  assert.match(source, /import \{ getProviderModule \} from '\.\.\/providers\/registry'/)
  assert.match(source, /getProviderModule\(provider\.id\)\?\.capabilities\?\.clearChats/)
  assert.match(source, /getProviderModule\(provider\.id\)\?\.capabilities\?\.credits/)
})
