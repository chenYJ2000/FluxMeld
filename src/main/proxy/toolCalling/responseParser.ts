import type { ToolCallingPlan, ToolParseResult, ToolProtocolId } from './types.ts'
import { getManagedProtocols, getToolProtocol } from './protocols/index.ts'

export function parseToolCallContent(content: string, plan: ToolCallingPlan): ToolParseResult {
  const protocols = orderedProtocols(plan.protocol)
  const results = protocols.map((protocol) =>
    protocol.parse(content, {
      tools: plan.tools,
      protocol: protocol.id,
    }),
  )
  const detectedProtocols = unique(
    results
      .filter((result) => result.protocol !== 'unknown')
      .map((result) => result.protocol as ToolProtocolId),
  )
  const successful = results.find((result) => result.toolCalls.length > 0)

  if (successful) {
    return { ...successful, detectedProtocols }
  }

  const informative =
    results.find(
      (result) =>
        result.rawMatches.length > 0 ||
        result.invalidToolNames.length > 0 ||
        Boolean(result.malformedReason),
    ) ?? results[0]
  const invalidToolNames = unique(results.flatMap((result) => result.invalidToolNames))
  const malformedToolNames = unique(results.flatMap((result) => result.malformedToolNames ?? []))
  const malformedReasons = unique(
    results
      .map((result) => result.malformedReason)
      .filter((reason): reason is string => Boolean(reason)),
  )

  return {
    ...informative,
    invalidToolNames,
    malformedToolNames,
    malformedReason: malformedReasons.join('; ') || undefined,
    detectedProtocols,
  }
}

export function findToolProtocolMarkerStart(
  buffer: string,
  plan: ToolCallingPlan,
): { matched: boolean; partial: boolean; index: number } {
  const detections = orderedProtocols(plan.protocol).map((protocol) => protocol.detectStart(buffer))
  const matched = detections
    .filter((item) => item.matched && item.markerStart !== undefined)
    .map((item) => item.markerStart as number)
  if (matched.length > 0) {
    return { matched: true, partial: false, index: Math.min(...matched) }
  }

  const partial = detections
    .filter((item) => item.partial && item.markerStart !== undefined)
    .map((item) => item.markerStart as number)
  return partial.length > 0
    ? { matched: false, partial: true, index: Math.min(...partial) }
    : { matched: false, partial: false, index: -1 }
}

function orderedProtocols(selectedId: ToolProtocolId) {
  const selected = getToolProtocol(selectedId)
  return [selected, ...getManagedProtocols().filter((protocol) => protocol.id !== selected.id)]
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values))
}
