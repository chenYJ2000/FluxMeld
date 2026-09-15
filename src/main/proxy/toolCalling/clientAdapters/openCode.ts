import type { ChatCompletionRequest } from '../../types.ts'
import type { NormalizedClientToolRequest, ToolClientAdapter } from './types.ts'
import type { NormalizedToolDefinition } from '../types.ts'
import { normalizeOpenAiTools, normalizeToolChoice } from './standardOpenAiTools.ts'

const DECLARED_TOOL_REFUSAL =
  /\btool\s+[`"'“”]?([A-Za-z0-9_:-]+)[`"'“”]?\s+(?:(?:does\s+not|doesn't)\s+exist(?:s)?|is\s+not\s+available)\b/gi
const REFUSAL_PREAMBLE =
  /^(?:\s*Tool\s+[A-Za-z0-9_:-]+\s+(?:(?:does\s+not|doesn't)\s+exist(?:s)?|is\s+not\s+available)\.?\s*)+/i
const READ_ONLY_PROJECT_TOOL_NAMES = new Set(['glob', 'grep', 'read'])
const CODE_CHANGE_TOOL_NAMES = new Set(['bash', 'glob', 'grep', 'read', 'edit', 'write'])
const READ_ONLY_PROJECT_INTENT =
  /(?:\b(?:read|review|inspect|explore|understand|analy[sz]e)\b|阅读|读一下|查看|看看|分析|审查|检查|了解|项目|代码)/i
const CODE_CHANGE_INTENT =
  /(?:\b(?:modify|edit|fix|implement|refactor|create|add|remove|replace|write)\b|修改|编辑|修复|实现|重构|添加|删除|替换|写入)/i
const NEGATED_TOOL_INSTRUCTION =
  /(?:\b(?:do\s+not|don't|never|avoid)\b|(?:不要|禁止|严禁))[^\r\n.!?。！？]{0,240}/gi

/**
 * OpenCode sends standard OpenAI function definitions and consumes standard
 * OpenAI tool calls. The managed protocol is an upstream concern only: the
 * engine parses it and returns a normal OpenAI tool_calls envelope with the
 * original tool names, valid call ids, and JSON arguments. Qwen's web model
 * follows FluxMeld's established bracket contract more reliably than a prompt
 * asking it to hand-author an OpenAI JSON response.
 */
export const openCodeAdapter: ToolClientAdapter = {
  id: 'opencode',
  displayName: 'OpenCode',
  normalizeRequest(request: ChatCompletionRequest): NormalizedClientToolRequest {
    const tools = selectOpenCodeTaskTools(request, normalizeOpenAiTools(request.tools, 'openai'))
    const normalizedChoice = normalizeToolChoice(request, new Set(tools.map((tool) => tool.name)))
    const explicitlyRequestedTool =
      normalizedChoice.mode === 'auto'
        ? findExplicitlyRequestedTool(
            request,
            tools.map((tool) => tool.name),
          )
        : undefined
    const implicitReadTool =
      normalizedChoice.mode === 'auto' ? findReadOnlyProjectStartingTool(request, tools) : undefined
    const toolChoice =
      explicitlyRequestedTool || implicitReadTool
        ? { mode: 'forced' as const, forcedName: explicitlyRequestedTool ?? implicitReadTool }
        : normalizedChoice

    return {
      clientAdapterId: 'opencode',
      toolSource: tools.length > 0 ? 'openai' : 'none',
      tools,
      toolChoice,
      preferredProtocolByProvider: {
        qwen: 'managed_bracket',
        'qwen-ai': 'managed_bracket',
      },
      diagnostics: {
        detectedClientType: 'opencode',
        rawToolCount: request.tools?.length ?? 0,
        normalizedToolNames: tools.map((tool) => tool.name),
      },
    }
  },

  createTrailingToolInstruction(protocol, tools) {
    if (tools.length === 0) return undefined

    if (protocol === 'managed_bracket') {
      return `[FluxMeld OpenCode compatibility tool contract]
If completing the task at hand requires a listed tool, return exactly one [function_calls] block and no prose. Never claim that a listed tool is unavailable. Use one exact listed name and encode arguments as one JSON object. If no tool is needed, answer normally.
Exact listed tool names: ${tools.map((tool) => tool.name).join(', ')}`
    }

    if (protocol === 'managed_xml') {
      return `[FluxMeld OpenCode compatibility tool contract]
If completing the task at hand requires a listed tool, return exactly one FluxMeld XML tool_calls block and no prose. Never claim that a listed tool is unavailable. Use one exact listed name and encode every argument using the tool's JSON schema. If no tool is needed, answer normally.
Exact listed tool names: ${tools.map((tool) => tool.name).join(', ')}`
    }

    if (protocol !== 'openai_chat') return undefined

    const singleToolContract = tools.length === 1 ? renderSingleToolContract(tools[0]) : ''

    return `[FluxMeld OpenCode compatibility tool contract]
If completing the task at hand requires a listed tool, return exactly one OpenAI chat-completions JSON object with tool_calls and no prose. Never claim that a listed tool is unavailable. Use one exact listed name and encode function.arguments as a JSON string. If no tool is needed, answer normally.
Exact listed tool names: ${tools.map((tool) => tool.name).join(', ')}${singleToolContract}`
  },

  detectToolRefusal(content, allowedToolNames) {
    // Qwen sometimes prepends stale refusal sentences to a substantive
    // project summary. That is not a refusal of the current request.
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

    // Qwen occasionally refuses a named OpenCode capability in prose instead
    // of using the standard "Tool <name> does not exist" wording. Require the
    // exact declared name and an explicit inability verb so ordinary answers
    // that merely mention tools are not retried.
    for (const toolName of allowedToolNames) {
      const escapedName = escapeRegExp(toolName)
      const namedCapabilityRefusal = new RegExp(
        `\\b(?:cannot|can't|unable\\s+to)\\s+(?:run|use|invoke|call)\\s+(?:the\\s+)?${escapedName}(?:\\s+(?:tool|commands?))?\\b`,
        'i',
      )
      if (namedCapabilityRefusal.test(content)) return { toolName }
    }

    return undefined
  },

  stripToolRefusalPreamble(content) {
    return stripToolRefusalPreamble(content)
  },
}

function selectOpenCodeTaskTools(
  request: ChatCompletionRequest,
  tools: NormalizedToolDefinition[],
): NormalizedToolDefinition[] {
  const userText = getLastUserText(request)
  if (!userText) return tools

  const preferredNames = isCodeChangeTask(userText)
    ? CODE_CHANGE_TOOL_NAMES
    : isReadOnlyProjectTask(userText)
      ? READ_ONLY_PROJECT_TOOL_NAMES
      : undefined
  if (!preferredNames) return tools

  const selected = tools.filter((tool) => preferredNames.has(tool.name))
  return selected.length > 0 ? selected : tools
}

function findReadOnlyProjectStartingTool(
  request: ChatCompletionRequest,
  tools: NormalizedToolDefinition[],
): string | undefined {
  const userText = getLastUserText(request)
  if (!userText || !isReadOnlyProjectTask(userText) || hasToolCallSinceLastUser(request)) {
    return undefined
  }

  return (
    tools.find((tool) => tool.name === 'glob')?.name ??
    tools.find((tool) => tool.name === 'grep')?.name ??
    tools.find((tool) => tool.name === 'read')?.name
  )
}

function isReadOnlyProjectTask(content: string): boolean {
  return READ_ONLY_PROJECT_INTENT.test(content) && !isCodeChangeTask(content)
}

function isCodeChangeTask(content: string): boolean {
  const withoutNegatedToolInstructions = content.replace(NEGATED_TOOL_INSTRUCTION, '')
  return CODE_CHANGE_INTENT.test(withoutNegatedToolInstructions)
}

function getLastUserText(request: ChatCompletionRequest): string | undefined {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index]
    if (message.role === 'user' && typeof message.content === 'string') return message.content
  }
  return undefined
}

function hasToolCallSinceLastUser(request: ChatCompletionRequest): boolean {
  const lastUserIndex = request.messages.findLastIndex((message) => message.role === 'user')
  return (
    lastUserIndex >= 0 &&
    request.messages
      .slice(lastUserIndex + 1)
      .some((message) => message.role === 'assistant' && (message.tool_calls?.length ?? 0) > 0)
  )
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function stripToolRefusalPreamble(content: string): string | undefined {
  const cleaned = content.replace(REFUSAL_PREAMBLE, '').trimStart()
  return cleaned && cleaned !== content ? cleaned : undefined
}

function renderSingleToolContract(tool: NormalizedClientToolRequest['tools'][number]): string {
  const definition = JSON.stringify({ name: tool.name, parameters: tool.parameters })
  if (definition.length > 12_000) return ''

  return `
Required function definition: ${definition}
Return shape: {"tool_calls":[{"id":"call_1","type":"function","function":{"name":"${tool.name}","arguments":"{...}"}}]}`
}

function findExplicitlyRequestedTool(
  request: ChatCompletionRequest,
  toolNames: string[],
): string | undefined {
  const lastUserIndex = request.messages.findLastIndex(
    (message) => message.role === 'user' && typeof message.content === 'string',
  )
  if (lastUserIndex < 0) return undefined

  const content = request.messages[lastUserIndex].content as string
  const requestedTools: Array<{ name: string; index: number }> = []

  for (const toolName of toolNames) {
    const escapedName = escapeRegExp(toolName)
    const quotedName = `(?:[\\x60"'])?${escapedName}(?:[\\x60"'])?`
    const affirmative = new RegExp(
      `\\b(?:use|call|invoke|run)\\s+(?:the\\s+)?${quotedName}(?:\\s+tool)?\\b`,
      'i',
    )
    const negative = new RegExp(
      `\\b(?:do\\s+not|don't|never)\\s+(?:use|call|invoke|run)\\s+(?:the\\s+)?${quotedName}(?:\\s+tool)?\\b`,
      'i',
    )
    const match = affirmative.exec(content)
    if (match && !negative.test(content)) {
      requestedTools.push({ name: toolName, index: match.index })
    }
  }

  if (requestedTools.length === 0) return undefined

  const alreadyCalled = new Set(
    request.messages
      .slice(lastUserIndex + 1)
      .filter((message) => message.role === 'assistant')
      .flatMap((message) => message.tool_calls ?? [])
      .map((toolCall) => toolCall.function.name),
  )
  return requestedTools
    .sort((left, right) => left.index - right.index)
    .find((tool) => !alreadyCalled.has(tool.name))?.name
}
