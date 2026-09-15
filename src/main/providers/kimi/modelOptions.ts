export type KimiScenario = 'SCENARIO_K2D5' | 'SCENARIO_OK_COMPUTER'

export type KimiReasoningEffort =
  | 'REASONING_EFFORT_NONE'
  | 'REASONING_EFFORT_LOW'
  | 'REASONING_EFFORT_HIGH'
  | 'REASONING_EFFORT_MAX'

const KIMI_STANDARD_EFFORTS = new Set([
  'false',
  'none',
  'off',
  'disabled',
  'minimal',
  'low',
  'standard',
  'reasoning_effort_none',
  'reasoning_effort_minimal',
  'reasoning_effort_low',
])

const KIMI_ADVANCED_EFFORTS = new Set([
  'true',
  'enabled',
  'medium',
  'high',
  'advanced',
  'reasoning_effort_medium',
  'reasoning_effort_high',
])

const KIMI_MAX_EFFORTS = new Set([
  'xhigh',
  'max',
  'extreme',
  'reasoning_effort_xhigh',
  'reasoning_effort_max',
])

export class KimiRequestValidationError extends Error {
  readonly status = 400

  constructor(message: string) {
    super(message)
    this.name = 'KimiRequestValidationError'
  }
}

export function resolveKimiScenario(model: string): KimiScenario {
  // K2.6 uses the K2D5 route in the Kimi web protocol, while K3 uses
  // the OK Computer route.
  return model.toLowerCase().includes('k2') ? 'SCENARIO_K2D5' : 'SCENARIO_OK_COMPUTER'
}

export function resolveKimiReasoningEffort(
  model: string,
  value?: string | boolean | null,
): KimiReasoningEffort {
  const isK3 = resolveKimiScenario(model) === 'SCENARIO_OK_COMPUTER'

  // Match the website defaults: K3 defaults to Advanced (HIGH), while the
  // K2.6 route defaults to its highest supported level (LOW).
  if (value === undefined || value === null) {
    return isK3 ? 'REASONING_EFFORT_HIGH' : 'REASONING_EFFORT_LOW'
  }

  const normalized = String(value).trim().toLowerCase()
  if (KIMI_STANDARD_EFFORTS.has(normalized)) {
    return isK3 ? 'REASONING_EFFORT_LOW' : 'REASONING_EFFORT_NONE'
  }
  if (KIMI_ADVANCED_EFFORTS.has(normalized)) {
    return isK3 ? 'REASONING_EFFORT_HIGH' : 'REASONING_EFFORT_LOW'
  }
  if (KIMI_MAX_EFFORTS.has(normalized)) {
    return isK3 ? 'REASONING_EFFORT_MAX' : 'REASONING_EFFORT_LOW'
  }

  throw new KimiRequestValidationError(`Unsupported Kimi reasoning_effort: ${String(value)}`)
}

export function createKimiChatPayload(options: {
  model: string
  content: string
  enableWebSearch: boolean
  reasoningEffort?: string | boolean | null
  /** @deprecated Use reasoningEffort. Kept for compatibility with older callers. */
  enableThinking?: boolean
}) {
  const scenario = resolveKimiScenario(options.model)
  const reasoningEffort = resolveKimiReasoningEffort(
    options.model,
    options.reasoningEffort ?? options.enableThinking,
  )
  const isK3 = scenario === 'SCENARIO_OK_COMPUTER'

  return {
    scenario,
    chat_id: '',
    ...(isK3 ? { kimiplus_id: 'ok-computer' } : {}),
    tools: options.enableWebSearch ? [{ type: 'TOOL_TYPE_SEARCH', search: {} }] : [],
    message: {
      parent_id: '',
      role: 'user',
      blocks: [
        {
          message_id: '',
          text: { content: options.content },
        },
      ],
      scenario,
    },
    options: {
      // The current web client always enables the reasoning pipeline and uses
      // reasoning_effort to select Standard, Advanced, or Max.
      thinking: true,
      reasoning_effort: reasoningEffort,
      ...(isK3 ? { context_length: 'CONTEXT_LENGTH_L' } : {}),
    },
  }
}

export function encodeKimiGrpcFrame(payload: unknown): Buffer {
  const jsonBuffer = Buffer.from(JSON.stringify(payload), 'utf8')
  const frameBuffer = Buffer.alloc(5 + jsonBuffer.length)
  frameBuffer.writeUInt8(0, 0)
  frameBuffer.writeUInt32BE(jsonBuffer.length, 1)
  jsonBuffer.copy(frameBuffer, 5)
  return frameBuffer
}
