import type { ToolCall } from '../../types.ts'
import type { ToolProtocolAdapter } from './base.ts'
import {
  buildToolCall,
  createParseResult,
  detectMarkers,
  extractBalancedJsonObject,
  genericToolResultBlock,
  normalizeArguments,
  renderToolList,
  stripFencedCodeBlocks,
  toolNames,
} from './shared.ts'

export const openAiChatProtocol: ToolProtocolAdapter = {
  id: 'openai_chat',

  renderPrompt(tools) {
    return `## Available Tools
${renderToolList(tools)}

When you need to call a tool, return exactly one OpenAI chat-completions JSON object and nothing else. Tool names are case-sensitive: use only an exact name listed above. The function.arguments field MUST be a JSON-encoded string, not a JSON object.

The calling client executes every returned tool call. Never simulate a tool result, never claim that a listed tool is unavailable, and never render a tool call as prose. If the user explicitly asks to run, read, write, search, or otherwise use a listed tool, you MUST return that tool call instead of answering the request yourself.

Example shape (use the selected tool's real name and schema):
{"tool_calls":[{"id":"call_1","type":"function","function":{"name":"exact_tool_name","arguments":"{\\"argument\\":\\"value\\"}"}}]}

If no tool is needed, reply with normal text. Do not use XML, markdown fences, or a provider-specific tool syntax.`
  },

  detectStart(buffer) {
    const detected = detectMarkers(buffer, [
      '"tool_calls"',
      '"function_call"',
      '{"tool_calls"',
      '{ "tool_calls"',
    ])
    if (detected.matched && detected.markerStart !== undefined) {
      const objectStart = buffer.lastIndexOf('{', detected.markerStart)
      if (objectStart !== -1 && /^\{\s*$/.test(buffer.slice(objectStart, detected.markerStart))) {
        return { ...detected, markerStart: objectStart }
      }
      return detected
    }

    // Hold a pretty-printed JSON object while its first key is still split
    // across stream chunks. This prevents "{\n  " from being emitted as
    // ordinary content before the tool_calls marker arrives.
    const objectStart = buffer.lastIndexOf('{')
    if (objectStart !== -1 && /^\{\s*(?:"[^"\r\n]*)?$/.test(buffer.slice(objectStart))) {
      return { matched: false, partial: true, markerStart: objectStart }
    }
    return detected
  },

  parse(content, context) {
    const parseable = stripFencedCodeBlocks(content).trim()
    const hasMarker = /"(?:tool_calls|function_call)"\s*:/.test(parseable)
    const allowedNames = toolNames(context.tools)
    const invalidToolNames: string[] = []
    const toolCalls: ToolCall[] = []
    const parsedEnvelope = parseJsonEnvelope(parseable)

    if (!parsedEnvelope) {
      const malformedToolNames = hasMarker ? extractAllowedNames(parseable, allowedNames) : []
      return createParseResult({
        content,
        toolCalls,
        protocol: hasMarker ? 'openai_chat' : 'unknown',
        // A streaming JSON object may simply be incomplete. Do not mark the
        // partial buffer as a consumed raw match or the stream parser would
        // discard it before the closing braces arrive.
        rawMatches: [],
        malformedToolNames,
        malformedReason: hasMarker ? 'openai_chat_json_parse_failed' : undefined,
      })
    }

    const candidates = extractCandidates(parsedEnvelope.value)
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object') continue
      const record = candidate as Record<string, any>
      const fn = record.function && typeof record.function === 'object' ? record.function : record
      const name = typeof fn.name === 'string' ? fn.name.trim() : ''
      if (!allowedNames.has(name)) {
        if (name) invalidToolNames.push(name)
        continue
      }

      toolCalls.push(
        buildToolCall(
          typeof record.id === 'string' ? record.id : `call_${toolCalls.length}`,
          toolCalls.length,
          name,
          normalizeArguments(fn.arguments ?? fn.parameters ?? {}),
          parsedEnvelope.raw,
        ),
      )
    }

    const recognized = hasMarker || candidates.length > 0
    const malformedToolNames =
      recognized && toolCalls.length === 0 && invalidToolNames.length === 0
        ? extractAllowedNames(parsedEnvelope.raw, allowedNames)
        : []
    return createParseResult({
      content: toolCalls.length > 0 ? '' : content,
      toolCalls,
      protocol: recognized ? 'openai_chat' : 'unknown',
      rawMatches: recognized ? [parsedEnvelope.raw] : [],
      invalidToolNames,
      malformedToolNames,
      malformedReason:
        recognized && toolCalls.length === 0 && invalidToolNames.length === 0
          ? 'openai_chat_has_no_parseable_tool_calls'
          : undefined,
    })
  },

  formatAssistantToolCalls(calls) {
    return JSON.stringify({
      tool_calls: calls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      })),
    })
  },

  formatToolResult(result) {
    return genericToolResultBlock(result)
  },
}

function extractCandidates(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (!value || typeof value !== 'object') return []
  const record = value as Record<string, any>
  if (Array.isArray(record.tool_calls)) return record.tool_calls
  if (record.function_call && typeof record.function_call === 'object')
    return [record.function_call]
  if (typeof record.name === 'string' && Object.prototype.hasOwnProperty.call(record, 'arguments'))
    return [record]

  const message =
    record.message ?? (Array.isArray(record.choices) ? record.choices[0]?.message : undefined)
  if (message && Array.isArray(message.tool_calls)) return message.tool_calls
  if (message?.function_call && typeof message.function_call === 'object')
    return [message.function_call]
  return []
}

function parseJsonEnvelope(content: string): { value: unknown; raw: string } | undefined {
  try {
    return { value: JSON.parse(content), raw: content }
  } catch {
    // Models sometimes surround otherwise valid OpenAI JSON with a short
    // explanation. Scan complete balanced objects and select the first actual
    // tool-call envelope instead of treating the surrounding prose as JSON.
  }

  let offset = 0
  while (offset < content.length) {
    const objectStart = content.indexOf('{', offset)
    if (objectStart === -1) return undefined
    const raw = extractBalancedJsonObject(content.slice(objectStart))
    if (!raw) return undefined

    try {
      const value = JSON.parse(raw)
      if (extractCandidates(value).length > 0) return { value, raw }
    } catch {
      // The balanced scanner is string-aware, but continue defensively if an
      // unusual JSON fragment is still invalid.
    }
    offset = objectStart + Math.max(raw.length, 1)
  }

  return undefined
}

function extractAllowedNames(content: string, allowedNames: Set<string>): string[] {
  const names: string[] = []
  const pattern = /"name"\s*:\s*"([^"]+)"/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(content)) !== null) {
    const name = match[1].trim()
    if (allowedNames.has(name) && !names.includes(name)) names.push(name)
  }
  return names
}
