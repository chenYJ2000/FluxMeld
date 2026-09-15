import type { ToolCallingPlan } from './types.ts'
import { stripFencedCodeBlocks } from './protocols/shared.ts'
import { findToolProtocolMarkerStart, parseToolCallContent } from './responseParser.ts'
import { ToolCallingResponseError, validateAndSanitizeToolCalls } from './ToolCallingEngine.ts'

export class ToolStreamParser {
  private readonly plan: ToolCallingPlan
  private buffer = ''
  private isBufferingToolCall = false
  private emittedToolCall = false
  private nextToolCallIndex = 0

  constructor(plan: ToolCallingPlan) {
    this.plan = plan
  }

  push(content: string, baseChunk: any, includeRole: boolean = false): any[] {
    if (!content || !this.plan.shouldParseResponse) return []
    if (this.emittedToolCall) return []

    this.buffer += content
    const chunks: any[] = []

    if (!this.isBufferingToolCall) {
      const markerStart = findMarkerStart(this.buffer, this.plan)
      if (markerStart.matched) {
        if (markerStart.index > 0) {
          const prefix = stripFencedCodeBlocks(this.buffer.slice(0, markerStart.index))
          if (prefix) chunks.push(createContentChunk(baseChunk, prefix, includeRole))
        }
        this.buffer = this.buffer.slice(markerStart.index)
        this.isBufferingToolCall = true
      } else if (markerStart.partial) {
        if (markerStart.index > 0) {
          const prefix = stripFencedCodeBlocks(this.buffer.slice(0, markerStart.index))
          if (prefix) chunks.push(createContentChunk(baseChunk, prefix, includeRole))
          this.buffer = this.buffer.slice(markerStart.index)
        }
        this.isBufferingToolCall = true
        return chunks
      } else {
        chunks.push(createContentChunk(baseChunk, this.buffer, includeRole))
        this.buffer = ''
        return chunks
      }
    }

    const parsed = parseBufferedToolCall(this.buffer, this.plan)
    if (parsed.toolCalls.length > 0) {
      const validatedToolCalls = validateAndSanitizeToolCalls(parsed.toolCalls, this.plan)
      for (const toolCall of validatedToolCalls) {
        const indexedToolCall = {
          ...toolCall,
          index: this.nextToolCallIndex,
          id: toolCall.id || `call_${this.nextToolCallIndex}`,
        }
        this.nextToolCallIndex += 1
        chunks.push(
          createToolCallChunk(baseChunk, indexedToolCall, includeRole && !this.emittedToolCall),
        )
      }
      this.emittedToolCall = true
      this.isBufferingToolCall = false
      this.buffer = ''
      return chunks
    }

    return chunks
  }

  flush(baseChunk: any): any[] {
    if (!this.buffer) {
      this.assertRequiredToolCall()
      return []
    }

    const parsed = parseBufferedToolCall(this.buffer, this.plan)
    if (parsed.toolCalls.length > 0) {
      const validatedToolCalls = validateAndSanitizeToolCalls(parsed.toolCalls, this.plan)
      const chunks = validatedToolCalls.map((toolCall) => {
        const indexedToolCall = {
          ...toolCall,
          index: this.nextToolCallIndex,
          id: toolCall.id || `call_${this.nextToolCallIndex}`,
        }
        this.nextToolCallIndex += 1
        this.emittedToolCall = true
        return createToolCallChunk(baseChunk, indexedToolCall, false)
      })
      this.buffer = ''
      this.isBufferingToolCall = false
      return chunks
    }

    const shouldReleaseText = !this.emittedToolCall
    const text = this.buffer
    this.buffer = ''
    this.isBufferingToolCall = false
    this.assertRequiredToolCall(parsed)
    const recognizedProtocol =
      parsed.protocol !== 'unknown' || Boolean(parsed.detectedProtocols?.length)
    return shouldReleaseText && !recognizedProtocol
      ? [createContentChunk(baseChunk, text, false)]
      : []
  }

  hasEmittedToolCall(): boolean {
    return this.emittedToolCall
  }

  isBuffering(): boolean {
    return this.isBufferingToolCall
  }

  private assertRequiredToolCall(parsed?: ReturnType<typeof parseToolCallContent>): void {
    if (this.emittedToolCall) return
    if (this.plan.toolChoiceMode !== 'required' && this.plan.toolChoiceMode !== 'forced') return

    const malformedName = parsed?.malformedToolNames?.[0]
    if (malformedName) {
      const reason = parsed?.malformedReason || 'arguments could not be parsed'
      throw new ToolCallingResponseError(
        `Upstream model returned invalid tool arguments for "${sanitizeName(malformedName)}": ${reason}`,
        'invalid_arguments',
        this.plan.diagnostics,
        [reason],
        malformedName,
        true,
      )
    }

    const details = [
      parsed?.invalidToolNames?.length
        ? `invalid tools: ${parsed.invalidToolNames.map(sanitizeName).join(', ')}`
        : undefined,
      parsed?.malformedReason,
    ]
      .filter(Boolean)
      .join('; ')
    throw new ToolCallingResponseError(
      `Upstream model did not return the required tool call${details ? ` (${details})` : ''}`,
      'missing_required_call',
      this.plan.diagnostics,
      [],
      undefined,
      false,
    )
  }
}

function parseBufferedToolCall(buffer: string, plan: ToolCallingPlan) {
  const parsed = parseToolCallContent(buffer, plan)
  plan.diagnostics = {
    ...plan.diagnostics,
    parserFormat: parsed.protocol,
    detectedProtocols: parsed.detectedProtocols,
    parsedToolCallCount: parsed.toolCalls.length,
    invalidToolNames: [...parsed.invalidToolNames],
    malformedToolNames: [...(parsed.malformedToolNames ?? [])],
    malformedReason: parsed.malformedReason,
  }
  return parsed
}

function findMarkerStart(
  buffer: string,
  plan: ToolCallingPlan,
): { matched: boolean; partial: boolean; index: number } {
  return findToolProtocolMarkerStart(buffer, plan)
}

function sanitizeName(name: string): string {
  return name.replace(/[\r\n\t]/g, ' ').slice(0, 128)
}

function createContentChunk(baseChunk: any, content: string, includeRole: boolean): any {
  return {
    ...baseChunk,
    choices: [
      {
        index: 0,
        delta: {
          ...(includeRole ? { role: 'assistant' } : {}),
          content,
        },
        finish_reason: null,
      },
    ],
  }
}

function createToolCallChunk(baseChunk: any, toolCall: any, includeRole: boolean): any {
  const { rawText, ...openAiToolCall } = toolCall
  void rawText

  return {
    ...baseChunk,
    choices: [
      {
        index: 0,
        delta: {
          ...(includeRole ? { role: 'assistant' } : {}),
          tool_calls: [openAiToolCall],
        },
        finish_reason: null,
      },
    ],
  }
}
