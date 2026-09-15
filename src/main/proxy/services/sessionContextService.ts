/**
 * Helpers for the optional FluxMeld stateful-session extension.
 *
 * A client opts in by sending `session_id` (or the
 * `X-FluxMeld-Session-Id` header).  These helpers intentionally keep the
 * OpenAI message shape intact so function-calling conversations remain valid.
 */

import type { ChatMessage } from '../types'

type StreamToolCall = NonNullable<ChatMessage['tool_calls']>[number]

function cloneContent(content: ChatMessage['content']): ChatMessage['content'] {
  if (!Array.isArray(content)) return content

  return content.map((part) => ({
    ...part,
    ...(part.image_url ? { image_url: { ...part.image_url } } : {}),
  }))
}

function cloneToolCalls(toolCalls: ChatMessage['tool_calls']): ChatMessage['tool_calls'] {
  return toolCalls?.map((toolCall) => ({
    ...toolCall,
    function: { ...toolCall.function },
  }))
}

/** Create an immutable copy suitable for session persistence or request reuse. */
export function cloneChatMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    content: cloneContent(message.content),
    ...(message.tool_calls ? { tool_calls: cloneToolCalls(message.tool_calls) } : {}),
  }
}

function messageSignature(message: ChatMessage): string {
  return JSON.stringify({
    role: message.role,
    content: message.content,
    ...(message.name ? { name: message.name } : {}),
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    ...(message.tool_calls
      ? {
          tool_calls: message.tool_calls.map((toolCall) => ({
            id: toolCall.id,
            type: toolCall.type,
            function: {
              name: toolCall.function.name,
              arguments: toolCall.function.arguments,
            },
          })),
        }
      : {}),
  })
}

/**
 * Combines persisted history with an incoming turn without duplicating the
 * common "full history + one new message" client request shape.
 */
export function mergeSessionMessages(
  history: ChatMessage[],
  incoming: ChatMessage[],
): ChatMessage[] {
  const saved = history.map(cloneChatMessage)
  const next = incoming.map(cloneChatMessage)

  if (saved.length === 0 || next.length === 0) return [...saved, ...next]

  const savedSignatures = saved.map(messageSignature)
  const nextSignatures = next.map(messageSignature)

  // The caller supplied the complete conversation already.
  if (
    savedSignatures.length <= nextSignatures.length &&
    savedSignatures.every((signature, index) => signature === nextSignatures[index])
  ) {
    return next
  }

  // The caller supplied a recent suffix plus new messages. Append only the
  // portion that is not already present in the persisted session.
  const largestOverlap = Math.min(savedSignatures.length, nextSignatures.length)
  for (let overlap = largestOverlap; overlap > 0; overlap--) {
    const savedOffset = savedSignatures.length - overlap
    const overlaps = nextSignatures
      .slice(0, overlap)
      .every((signature, index) => signature === savedSignatures[savedOffset + index])

    if (overlaps) return [...saved, ...next.slice(overlap)]
  }

  return [...saved, ...next]
}

/**
 * Builds a complete assistant message from an OpenAI-compatible non-stream
 * completion response.  Invalid or empty responses are ignored safely.
 */
export function assistantMessageFromResponse(response: unknown): ChatMessage | undefined {
  if (!response || typeof response !== 'object') return undefined

  const choice = (response as { choices?: unknown[] }).choices?.[0]
  if (!choice || typeof choice !== 'object') return undefined

  const message = (choice as { message?: unknown }).message
  if (!message || typeof message !== 'object') return undefined

  const candidate = message as Partial<ChatMessage>
  if (candidate.role !== 'assistant') return undefined
  if (
    typeof candidate.content !== 'string' &&
    candidate.content !== null &&
    !Array.isArray(candidate.content)
  )
    return undefined

  return cloneChatMessage({
    role: 'assistant',
    content: candidate.content,
    ...(typeof candidate.name === 'string' ? { name: candidate.name } : {}),
    ...(Array.isArray(candidate.tool_calls)
      ? {
          tool_calls: candidate.tool_calls as ChatMessage['tool_calls'],
        }
      : {}),
  })
}

function mergeStreamToolCall(
  current: StreamToolCall | undefined,
  delta: Record<string, unknown>,
): StreamToolCall {
  const functionDelta =
    delta.function && typeof delta.function === 'object'
      ? (delta.function as Record<string, unknown>)
      : {}
  const currentFunction = current?.function ?? { name: '', arguments: '' }

  return {
    id: typeof delta.id === 'string' ? delta.id : (current?.id ?? ''),
    type: delta.type === 'function' ? 'function' : (current?.type ?? 'function'),
    function: {
      name:
        typeof functionDelta.name === 'string'
          ? `${currentFunction.name}${functionDelta.name}`
          : currentFunction.name,
      arguments:
        typeof functionDelta.arguments === 'string'
          ? `${currentFunction.arguments}${functionDelta.arguments}`
          : currentFunction.arguments,
    },
  }
}

/**
 * Parses a completed OpenAI SSE payload into the assistant turn that should
 * be persisted for a stateful session.  Malformed events are ignored so a
 * provider-specific keepalive cannot fail an otherwise successful response.
 */
export function assistantMessageFromSSE(payload: string): ChatMessage | undefined {
  let content = ''
  const toolCalls = new Map<number, StreamToolCall>()

  for (const line of payload.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue

    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') continue

    try {
      const event = JSON.parse(data) as { choices?: Array<{ delta?: Record<string, unknown> }> }
      for (const choice of event.choices ?? []) {
        const delta = choice.delta
        if (!delta) continue

        if (typeof delta.content === 'string') content += delta.content

        if (Array.isArray(delta.tool_calls)) {
          for (const rawToolCall of delta.tool_calls) {
            if (!rawToolCall || typeof rawToolCall !== 'object') continue
            const toolCall = rawToolCall as Record<string, unknown>
            const index = typeof toolCall.index === 'number' ? toolCall.index : toolCalls.size
            toolCalls.set(index, mergeStreamToolCall(toolCalls.get(index), toolCall))
          }
        }
      }
    } catch {
      // Ignore malformed SSE events; the upstream stream already owns error handling.
    }
  }

  const completedToolCalls = Array.from(toolCalls.entries())
    .sort(([left], [right]) => left - right)
    .map(([, toolCall]) => toolCall)
    .filter((toolCall) => toolCall.id || toolCall.function.name || toolCall.function.arguments)

  if (!content && completedToolCalls.length === 0) return undefined

  return {
    role: 'assistant',
    content: content || null,
    ...(completedToolCalls.length > 0 ? { tool_calls: completedToolCalls } : {}),
  }
}
