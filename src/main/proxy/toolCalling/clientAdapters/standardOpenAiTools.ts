import type { ChatCompletionRequest, ChatCompletionTool } from '../../types.ts'
import type { NormalizedToolDefinition } from '../types.ts'
import type {
  NormalizedClientToolRequest,
  NormalizedToolChoice,
  ToolClientAdapter,
} from './types.ts'

const DECLARED_TOOL_REFUSAL =
  /\btool\s+[`"'“”]?([A-Za-z0-9_:-]+)[`"'“”]?\s+(?:(?:does\s+not|doesn't)\s+exist(?:s)?|is\s+not\s+available)\b/gi
const REFUSAL_PREAMBLE =
  /^(?:\s*Tool\s+[A-Za-z0-9_:-]+\s+(?:(?:does\s+not|doesn't)\s+exist(?:s)?|is\s+not\s+available)\.?\s*)+/i

export function normalizeOpenAiTools(
  tools: ChatCompletionTool[] | undefined,
  source: 'openai' | 'mcp',
): NormalizedToolDefinition[] {
  return (tools ?? [])
    .filter((tool) => tool.type === 'function' && Boolean(tool.function?.name))
    .map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters ?? {},
      source,
    }))
}

export function normalizeToolChoice(
  request: ChatCompletionRequest,
  toolNames: Set<string>,
): NormalizedToolChoice {
  const choice = request.tool_choice
  if (choice === 'none') return { mode: 'none' }
  if (choice === 'required') return { mode: 'required' }
  if (choice && typeof choice === 'object' && choice.type === 'function') {
    return { mode: 'forced', forcedName: choice.function.name }
  }
  if (toolNames.size === 1) return { mode: 'auto' }
  return { mode: 'auto' }
}

export const standardOpenAiToolsAdapter: ToolClientAdapter = {
  id: 'standard-openai-tools',
  displayName: 'Standard OpenAI Tools',
  normalizeRequest(request): NormalizedClientToolRequest {
    const tools = normalizeOpenAiTools(request.tools, 'openai')
    const toolChoice = normalizeToolChoice(request, new Set(tools.map((tool) => tool.name)))

    return {
      clientAdapterId: 'standard-openai-tools',
      toolSource: tools.length > 0 ? 'openai' : 'none',
      tools,
      toolChoice,
      diagnostics: {
        rawToolCount: request.tools?.length ?? 0,
        normalizedToolNames: tools.map((tool) => tool.name),
      },
    }
  },

  // Prompt-emulated upstreams can occasionally describe a declared function
  // as unavailable instead of returning a tool call. Treat only that exact
  // refusal shape as retryable; ordinary prose remains untouched.
  detectToolRefusal(content, allowedToolNames) {
    if (stripToolRefusalPreamble(content)) return undefined

    const namesByLowerCase = new Map(
      [...allowedToolNames].map((toolName) => [toolName.toLowerCase(), toolName]),
    )
    DECLARED_TOOL_REFUSAL.lastIndex = 0
    let match: RegExpExecArray | null

    while ((match = DECLARED_TOOL_REFUSAL.exec(content)) !== null) {
      const toolName = namesByLowerCase.get(match[1].toLowerCase())
      if (toolName) return { toolName }
    }

    return undefined
  },

  stripToolRefusalPreamble(content) {
    return stripToolRefusalPreamble(content)
  },
}

function stripToolRefusalPreamble(content: string): string | undefined {
  const cleaned = content.replace(REFUSAL_PREAMBLE, '').trimStart()
  return cleaned && cleaned !== content ? cleaned : undefined
}
