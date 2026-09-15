export interface ModelDeprecation {
  model: string
  replacement?: string
  message: string
}

const MODEL_DEPRECATIONS: Record<string, ModelDeprecation> = {
  'glm-5.1': {
    model: 'GLM-5.1',
    replacement: 'GLM-5.2',
    message:
      'GLM-5.1 is no longer available from the GLM web provider. GLM-5.2 has different behavior and is not selected automatically. Validate it first, then add an explicit model mapping from GLM-5.1 to GLM-5.2 if desired.',
  },
}

export function getModelDeprecation(model: string): ModelDeprecation | undefined {
  const deprecation = MODEL_DEPRECATIONS[model.trim().toLowerCase()]
  return deprecation ? { ...deprecation } : undefined
}
