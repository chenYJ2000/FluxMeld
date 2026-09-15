import type { ToolProtocolAdapter } from './base.ts'
import type { ToolParseContext } from '../types.ts'
import {
  addParameter,
  buildToolCall,
  createParseResult,
  detectMarkers,
  escapeXmlAttribute,
  parseJsonObject,
  parseJsonValue,
  renderToolList,
  stripFencedCodeBlocks,
  toolNames,
} from './shared.ts'

const FLUXMELD_START = '<|FLUXMELD|tool_calls>'
const FLUXMELD_END = '</|FLUXMELD|tool_calls>'
const XML_START = '<tool_calls>'

export const managedXmlProtocol: ToolProtocolAdapter = {
  id: 'managed_xml',

  renderPrompt(tools) {
    return `## Available Tools
You can invoke the following developer tools. Tool names are case-sensitive.
Use only the exact tool names listed below. Do not rename, camelCase, translate, shorten, or invent tool names.

${renderToolList(tools)}

The tool list is authoritative for this request. Every listed tool is callable through the client. Never say a listed tool is unavailable and never narrate an intended tool call; emit the required block instead.

When calling tools, respond with exactly one FluxMeld XML block. Do not include reasoning, prose, markdown fences, or draft tool calls.

Every top-level JSON argument MUST be a separate parameter. Preserve JSON types: strings may be plain CDATA text; numbers, booleans, arrays, objects, and null must use valid JSON values.

Multi-field structure example (field names are illustrative only; use the selected tool's real schema):

<|FLUXMELD|tool_calls><|FLUXMELD|invoke name="exact_tool_name"><|FLUXMELD|parameter name="field_one"><![CDATA[text value]]></|FLUXMELD|parameter><|FLUXMELD|parameter name="field_two"><![CDATA[false]]></|FLUXMELD|parameter><|FLUXMELD|parameter name="field_three"><![CDATA[{"nested":"value"}]]></|FLUXMELD|parameter></|FLUXMELD|invoke></|FLUXMELD|tool_calls>

For a tool with arguments {"pair":"BTC/USDT","confidence":80,"cancel":false}, the required shape is:

<|FLUXMELD|tool_calls><|FLUXMELD|invoke name="exact_tool_name"><|FLUXMELD|parameter name="pair"><![CDATA[BTC/USDT]]></|FLUXMELD|parameter><|FLUXMELD|parameter name="confidence"><![CDATA[80]]></|FLUXMELD|parameter><|FLUXMELD|parameter name="cancel"><![CDATA[false]]></|FLUXMELD|parameter></|FLUXMELD|invoke></|FLUXMELD|tool_calls>

Never place the entire arguments object under a synthetic "argument" key. Never copy these illustrative field names unless they exist in the selected tool's schema.

Tool results will be provided as FluxMeld XML result blocks:

<|FLUXMELD|tool_result tool_call_id="call_id"><![CDATA[result]]></|FLUXMELD|tool_result>`
  },

  detectStart(buffer) {
    return detectMarkers(buffer, [FLUXMELD_START, XML_START])
  },

  parse(content: string, context: ToolParseContext) {
    const parseable = stripFencedCodeBlocks(content)
    const allowedNames = toolNames(context.tools)
    const rawMatches: string[] = []
    const invalidToolNames: string[] = []
    const malformedToolNames: string[] = []
    const malformedReasons: string[] = []
    const toolCalls: ReturnType<typeof buildToolCall>[] = []

    parseBlocks(parseable, {
      blockPattern: /<\|FLUXMELD\|tool_calls\b[^>]*>([\s\S]*?)<\/\|FLUXMELD\|tool_calls>/g,
      invokePattern:
        /<\|FLUXMELD\|invoke\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/\|FLUXMELD\|invoke>/g,
      parameterPattern:
        /<\|FLUXMELD\|parameter\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/\|FLUXMELD\|parameter>/g,
      rawMatches,
      invalidToolNames,
      malformedToolNames,
      malformedReasons,
      allowedNames,
      toolCalls,
    })

    parseBlocks(parseable, {
      blockPattern: /<tool_calls\b[^>]*>([\s\S]*?)<\/tool_calls>/g,
      invokePattern: /<invoke\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/invoke>/g,
      parameterPattern:
        /<parameter\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/g,
      rawMatches,
      invalidToolNames,
      malformedToolNames,
      malformedReasons,
      allowedNames,
      toolCalls,
    })

    if (toolCalls.length === 0) {
      return createParseResult({
        content,
        toolCalls,
        protocol: rawMatches.length > 0 ? 'managed_xml' : 'unknown',
        rawMatches,
        invalidToolNames,
        malformedToolNames,
        malformedReason: unique(malformedReasons).join('; ') || undefined,
      })
    }

    const cleanContent = rawMatches.reduce((acc, raw) => acc.replace(raw, ''), parseable).trim()
    return createParseResult({
      content: cleanContent,
      toolCalls,
      protocol: 'managed_xml',
      rawMatches,
      invalidToolNames,
      malformedToolNames,
      malformedReason: unique(malformedReasons).join('; ') || undefined,
    })
  },

  formatAssistantToolCalls(calls) {
    const invokes = calls.map((call) => {
      const args = safeParseObject(call.arguments)
      const params = Object.entries(args)
        .map(([name, value]) => {
          const text = typeof value === 'string' ? value : JSON.stringify(value)
          return `<|FLUXMELD|parameter name="${escapeXmlAttribute(name)}"><![CDATA[${text}]]></|FLUXMELD|parameter>`
        })
        .join('')
      return `<|FLUXMELD|invoke name="${escapeXmlAttribute(call.name)}">${params}</|FLUXMELD|invoke>`
    })
    return `${FLUXMELD_START}${invokes.join('')}${FLUXMELD_END}`
  },

  formatToolResult(result) {
    return `<|FLUXMELD|tool_result tool_call_id="${escapeXmlAttribute(result.toolCallId)}"><![CDATA[${result.content}]]></|FLUXMELD|tool_result>`
  },
}

interface ParseBlockOptions {
  blockPattern: RegExp
  invokePattern: RegExp
  parameterPattern: RegExp
  rawMatches: string[]
  invalidToolNames: string[]
  malformedToolNames: string[]
  malformedReasons: string[]
  allowedNames: Set<string>
  toolCalls: ReturnType<typeof buildToolCall>[]
}

function parseBlocks(content: string, options: ParseBlockOptions): void {
  let blockMatch: RegExpExecArray | null

  while ((blockMatch = options.blockPattern.exec(content)) !== null) {
    options.rawMatches.push(blockMatch[0])
    let invokeMatch: RegExpExecArray | null
    let invokeCount = 0

    while ((invokeMatch = options.invokePattern.exec(blockMatch[1])) !== null) {
      invokeCount += 1
      const name = invokeMatch[1].trim()
      if (!options.allowedNames.has(name)) {
        options.invalidToolNames.push(name)
        continue
      }

      const parameterArgs: Record<string, unknown> = {}
      const parameterMatches: string[] = []
      let parameterMatch: RegExpExecArray | null
      options.parameterPattern.lastIndex = 0
      while ((parameterMatch = options.parameterPattern.exec(invokeMatch[2])) !== null) {
        parameterMatches.push(parameterMatch[0])
        addParameter(parameterArgs, parameterMatch[1].trim(), parseJsonValue(parameterMatch[2]))
      }

      const residualBody = parameterMatches
        .reduce((remaining, rawParameter) => remaining.replace(rawParameter, ''), invokeMatch[2])
        .trim()
      const wrappedArguments = extractWrappedArguments(residualBody)
      const directArgs = parseJsonObject(wrappedArguments ?? residualBody)
      const args = normalizeParsedArguments(parameterArgs, directArgs)

      if (!args) {
        options.malformedToolNames.push(name)
        options.malformedReasons.push(`tool "${name}" invoke has no parseable JSON arguments`)
        continue
      }

      options.toolCalls.push(
        buildToolCall(
          `call_${options.toolCalls.length}`,
          options.toolCalls.length,
          name,
          JSON.stringify(args),
          invokeMatch[0],
        ),
      )
    }

    if (invokeCount === 0) {
      options.malformedReasons.push('tool_calls block has no parseable invoke element')
    }
  }
}

function normalizeParsedArguments(
  parameterArgs: Record<string, unknown>,
  directArgs: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const entries = Object.entries(parameterArgs)
  if (entries.length === 1 && (entries[0][0] === 'argument' || entries[0][0] === 'arguments')) {
    const wrapped = normalizeWrappedObject(entries[0][1])
    if (wrapped) return directArgs ? { ...directArgs, ...wrapped } : wrapped
  }

  if (entries.length > 0) {
    return directArgs ? { ...directArgs, ...parameterArgs } : parameterArgs
  }

  return directArgs
}

function normalizeWrappedObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return typeof value === 'string' ? parseJsonObject(value) : undefined
}

function extractWrappedArguments(value: string): string | undefined {
  const match = value.match(
    /<(?:arguments|parameters)>\s*([\s\S]*?)\s*<\/(?:arguments|parameters)>/i,
  )
  return match?.[1]
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values))
}

function safeParseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}
