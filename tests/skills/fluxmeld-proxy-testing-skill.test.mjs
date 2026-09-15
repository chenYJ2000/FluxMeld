import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const skillPaths = [
  {
    file: 'skills/fluxmeld-management-api/SKILL.md',
    name: 'fluxmeld-management-api',
    description:
      "Use when operating FluxMeld Manager's management API for testing, including health checks, config snapshots, temporary API keys, model mappings, sessions, logs, and cleanup verification.",
  },
  {
    file: 'skills/fluxmeld-har-tool-fixture/SKILL.md',
    name: 'fluxmeld-har-tool-fixture',
    description:
      'Use when converting OpenAI-compatible client HAR files into sanitized replayable FluxMeld tool-calling fixtures.',
  },
  {
    file: 'skills/fluxmeld-tool-client-replay/SKILL.md',
    name: 'fluxmeld-tool-client-replay',
    description:
      'Use when replaying sanitized client tool-calling fixtures against FluxMeld with client-specific pass/fail rules.',
  },
  {
    file: 'skills/fluxmeld-provider-model-matrix/SKILL.md',
    name: 'fluxmeld-provider-model-matrix',
    description:
      'Use when running FluxMeld provider and model matrix tests using live /v1/models discovery and management API attribution.',
  },
  {
    file: 'skills/fluxmeld-proxy-testing/SKILL.md',
    name: 'fluxmeld-proxy-testing',
    description:
      'Use when validating FluxMeld Manager proxy behavior across dialogue, tool calling, context, provider routing, request logs, and live client replay workflows.',
  },
]

const focusedSkillFiles = skillPaths
  .filter(({ name }) => name !== 'fluxmeld-proxy-testing')
  .map(({ file }) => file)
const implementedScriptPaths = [
  'skills/fluxmeld-management-api/scripts/management-api.mjs',
  'skills/fluxmeld-har-tool-fixture/scripts/extract-har-fixtures.mjs',
  'skills/fluxmeld-tool-client-replay/scripts/replay-client-fixture.mjs',
  'skills/fluxmeld-provider-model-matrix/scripts/run-model-matrix.mjs',
]

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

test('versioned FluxMeld testing skills exist and have trigger-only descriptions', () => {
  for (const { file, name, description } of skillPaths) {
    const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
    // Skill frontmatter is a discovery contract; keep exact names and descriptions stable.
    assert.match(
      text,
      new RegExp(
        `^---\\nname: ${escapeRegExp(name)}\\ndescription: ${escapeRegExp(description)}\\n---`,
        'm',
      ),
      file,
    )
    assert.doesNotMatch(text, /T[B]D|FI[X]ME|deferred work/, file)
  }
})

test('focused skill docs reference implemented script paths only', () => {
  for (const file of focusedSkillFiles) {
    const text = fs.readFileSync(file, 'utf8')
    assert.doesNotMatch(text, /Planned Script/, file)
  }

  for (const file of implementedScriptPaths) {
    assert.equal(fs.existsSync(file), true, file)
  }
})

test('proxy testing skill delegates focused responsibilities', () => {
  const text = fs.readFileSync('skills/fluxmeld-proxy-testing/SKILL.md', 'utf8')
  assert.match(text, /fluxmeld-management-api/)
  assert.match(text, /fluxmeld-har-tool-fixture/)
  assert.match(text, /fluxmeld-tool-client-replay/)
  assert.match(text, /fluxmeld-provider-model-matrix/)
})

test('versioned proxy testing skill warns against ignored local source of truth', () => {
  const text = fs.readFileSync('skills/fluxmeld-proxy-testing/SKILL.md', 'utf8')
  assert.match(text, /versioned source of truth/)
  assert.match(text, /ignored \.codex/)
})
