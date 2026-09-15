import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const projectRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const testsRoot = join(projectRoot, 'tests')
const testFilePattern = /\.test\.(?:js|mjs|ts)$/

async function collectTestFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return collectTestFiles(path)
      return testFilePattern.test(entry.name) ? [path] : []
    }),
  )

  return files.flat()
}

const testFiles = (await collectTestFiles(testsRoot)).sort()
if (testFiles.length === 0) {
  throw new Error('No test files found')
}

const child = spawn(
  process.execPath,
  ['--import', 'tsx', ...process.argv.slice(2), '--test', ...testFiles],
  {
    cwd: projectRoot,
    stdio: 'inherit',
  },
)

child.once('error', (error) => {
  console.error(error)
  process.exitCode = 1
})

child.once('exit', (code, signal) => {
  if (signal) {
    console.error(`Test process stopped by signal ${signal}`)
    process.exitCode = 1
    return
  }
  process.exitCode = code ?? 1
})
