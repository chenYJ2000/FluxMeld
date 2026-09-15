export type GLMChatMode = '' | 'thinking' | 'deep_thinking'

const GLM_FAST_EFFORTS = new Set([
  'false',
  'none',
  'off',
  'disabled',
  'minimal',
  'fast',
  'reasoning_effort_none',
  'reasoning_effort_minimal',
])

const GLM_STANDARD_EFFORTS = new Set([
  'true',
  'enabled',
  'low',
  'medium',
  'high',
  'standard',
  'reasoning_effort_low',
  'reasoning_effort_medium',
  'reasoning_effort_high',
])

const GLM_DEEP_EFFORTS = new Set([
  'xhigh',
  'max',
  'deep',
  'reasoning_effort_xhigh',
  'reasoning_effort_max',
])

export class GLMRequestValidationError extends Error {
  readonly status = 400

  constructor(message: string) {
    super(message)
    this.name = 'GLMRequestValidationError'
  }
}

export function resolveGLMChatMode(value?: string | boolean | null): GLMChatMode {
  // Match the current Qingyan web client: GLM-5.2 defaults to Standard.
  if (value === undefined || value === null) {
    return 'thinking'
  }

  const normalized = String(value).trim().toLowerCase()
  if (GLM_FAST_EFFORTS.has(normalized)) return ''
  if (GLM_STANDARD_EFFORTS.has(normalized)) return 'thinking'
  if (GLM_DEEP_EFFORTS.has(normalized)) return 'deep_thinking'

  throw new GLMRequestValidationError(`Unsupported GLM reasoning_effort: ${String(value)}`)
}
