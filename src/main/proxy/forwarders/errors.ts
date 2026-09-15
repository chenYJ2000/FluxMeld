/**
 * Shared forwarder error classification.
 *
 * Kept separate from `../forwarder.ts` so provider forwarders and the generic
 * orchestration can both use it without a circular import.
 */

import axios from 'axios'
import {
  QwenAiRequestValidationError,
  type QwenAiUpstreamCompletionState,
} from '../../providers/qwen-ai/adapter'
import { ToolCallingResponseError } from '../toolCalling/ToolCallingEngine'
import type { ToolCallingTransformResult } from '../toolCalling/types'
import type { ForwardResult } from '../types'

export class QwenAiMultiplexedResponseError extends Error {
  readonly status = 502
  readonly diagnostics: ToolCallingTransformResult['plan']['diagnostics']

  constructor(diagnostics: ToolCallingTransformResult['plan']['diagnostics']) {
    super('Qwen upstream multiplexed multiple unidentified responses; retry with a fresh chat')
    this.name = 'QwenAiMultiplexedResponseError'
    this.diagnostics = diagnostics
  }
}

export class QwenAiIncompleteResponseError extends Error {
  readonly status = 502
  readonly diagnostics: ToolCallingTransformResult['plan']['diagnostics']
  readonly toolName?: string
  readonly reasoningContent?: string

  constructor(
    completionState: Exclude<QwenAiUpstreamCompletionState, 'complete'>,
    diagnostics: ToolCallingTransformResult['plan']['diagnostics'],
    toolName?: string,
    reasoningContent?: string,
  ) {
    const reason =
      completionState === 'output_limit'
        ? 'the output limit was reached'
        : 'the upstream response ended early'
    super(`Qwen upstream did not complete the required tool call because ${reason}`)
    this.name = 'QwenAiIncompleteResponseError'
    this.diagnostics = diagnostics
    this.toolName = toolName
    this.reasoningContent = reasoningContent
  }
}

export function getForwardErrorStatus(error: unknown): number | undefined {
  if (error instanceof QwenAiRequestValidationError) return 400
  if (error instanceof ToolCallingResponseError) return error.status
  if (axios.isAxiosError(error)) return error.response?.status

  if (error && typeof error === 'object' && 'status' in error) {
    const status = Number((error as { status?: unknown }).status)
    if (Number.isInteger(status) && status >= 400 && status <= 599) return status
  }

  return undefined
}

export function createForwardFailure(error: unknown, startTime: number): ForwardResult {
  const message = error instanceof Error ? error.message : 'Unknown error'
  const toolCallingFailure: ForwardResult['toolCallingFailure'] =
    error instanceof ToolCallingResponseError
      ? {
          code: error.code,
          toolName: error.toolName,
          repairable: error.repairable,
          diagnostics: error.diagnostics,
          validationErrors: [...error.validationErrors],
          validationIssues: error.validationIssues.map((issue) => ({ ...issue })),
          rejectedArguments: error.rejectedArguments,
          reasoningContent: error.reasoningContent,
        }
      : error instanceof QwenAiMultiplexedResponseError
        ? {
            code: 'upstream_multiplexed_response',
            repairable: false,
            diagnostics: error.diagnostics,
          }
        : error instanceof QwenAiIncompleteResponseError
          ? {
              code: 'upstream_incomplete_response',
              toolName: error.toolName,
              repairable: true,
              diagnostics: error.diagnostics,
              reasoningContent: error.reasoningContent,
            }
          : undefined
  return {
    success: false,
    status: getForwardErrorStatus(error),
    error: message,
    latency: Date.now() - startTime,
    ...(toolCallingFailure ? { toolCallingFailure } : {}),
  }
}
