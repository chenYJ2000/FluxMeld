import { isReasoningEnabled } from '../../proxy/utils/reasoning'

export interface DeepSeekChatOptionInput {
  model: string
  web_search?: boolean
  reasoning_effort?: string | boolean
}

export interface DeepSeekChatOptions {
  modelType: 'default' | 'expert'
  searchEnabled: boolean
  thinkingEnabled: boolean
}

export function resolveDeepSeekChatOptions(
  request: DeepSeekChatOptionInput,
  _prompt: string = '',
): DeepSeekChatOptions {
  const modelLower = request.model.toLowerCase()
  const isProModel = modelLower.includes('deepseek-v4-pro') || modelLower.includes('expert')
  const isSearchAlias = modelLower.includes('search')
  const isThinkingAlias =
    modelLower.includes('think') || modelLower.includes('r1') || modelLower.includes('reasoner')

  return {
    modelType: isProModel ? 'expert' : 'default',
    searchEnabled: Boolean(request.web_search) || isSearchAlias,
    thinkingEnabled: isReasoningEnabled(request.reasoning_effort) || isThinkingAlias,
  }
}
