import type { ToolClientAdapterId } from '../../../../shared/toolCalling.ts'
import type { ChatCompletionRequest, ChatMessage } from '../../types.ts'
import type { ToolClientAdapter } from './types.ts'
import { standardOpenAiToolsAdapter } from './standardOpenAiTools.ts'
import { cherryStudioMcpAdapter } from './cherryStudioMcp.ts'
import { openCodeAdapter } from './openCode.ts'

const adapters = new Map<string, ToolClientAdapter>([
  [standardOpenAiToolsAdapter.id, standardOpenAiToolsAdapter],
  [cherryStudioMcpAdapter.id, cherryStudioMcpAdapter],
  [openCodeAdapter.id, openCodeAdapter],
])

const OPENCODE_SYSTEM_IDENTITY = /\byou\s+are\s+opencode\b/i

export interface ToolClientAdapterResolution {
  adapter: ToolClientAdapter
  configuredClientAdapterId: ToolClientAdapterId
  resolvedBy: 'configuration' | 'request_identity'
}

export function getToolClientAdapter(clientAdapterId: ToolClientAdapterId): ToolClientAdapter {
  const adapter = adapters.get(clientAdapterId)
  if (adapter) return adapter

  return {
    ...standardOpenAiToolsAdapter,
    normalizeRequest(request) {
      const result = standardOpenAiToolsAdapter.normalizeRequest(request)
      return {
        ...result,
        diagnostics: {
          ...result.diagnostics,
          requestedClientAdapterId: clientAdapterId,
          fallbackClientAdapterId: standardOpenAiToolsAdapter.id,
        },
      }
    },
  }
}

export function resolveToolClientAdapterForRequest(
  clientAdapterId: ToolClientAdapterId,
  request: Pick<ChatCompletionRequest, 'messages'>,
): ToolClientAdapterResolution {
  if (clientAdapterId === 'standard-openai-tools' && hasOpenCodeSystemIdentity(request.messages)) {
    return {
      adapter: openCodeAdapter,
      configuredClientAdapterId: clientAdapterId,
      resolvedBy: 'request_identity',
    }
  }

  return {
    adapter: getToolClientAdapter(clientAdapterId),
    configuredClientAdapterId: clientAdapterId,
    resolvedBy: 'configuration',
  }
}

export function hasOpenCodeSystemIdentity(messages: ChatMessage[]): boolean {
  return messages.some(
    (message) =>
      message.role === 'system' && OPENCODE_SYSTEM_IDENTITY.test(getMessageText(message.content)),
  )
}

export function listToolClientAdapters(): ToolClientAdapter[] {
  return [standardOpenAiToolsAdapter, cherryStudioMcpAdapter, openCodeAdapter]
}

function getMessageText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n')
}
