/**
 * Proxy Service Module - Models Route
 * Implements /v1/models route
 */

import Router from '@koa/router'
import type { Context } from 'koa'
import { ModelsResponse, ModelInfo } from '../types'
import { loadBalancer } from '../loadbalancer'
import { storeManager } from '../../store/store'
import { getModelDeprecation } from '../modelDeprecations'

const router = new Router({ prefix: '/v1' })

/**
 * Get all available models
 */
router.get('/models', async (ctx: Context) => {
  const providers = storeManager.getProviders().filter((p) => p.enabled)
  const models: ModelInfo[] = []
  const addedModels = new Set<string>()

  for (const provider of providers) {
    const accounts = storeManager
      .getAccountsByProviderId(provider.id)
      .filter((account) => account.status === 'active')

    if (accounts.length === 0) {
      continue
    }

    const effectiveModels = storeManager.getEffectiveModels(provider.id)
    for (const model of effectiveModels) {
      if (
        !addedModels.has(model.displayName) &&
        loadBalancer.getAvailableAccountCount(model.displayName, provider.id) > 0
      ) {
        addedModels.add(model.displayName)
        models.push({
          id: model.displayName,
          object: 'model',
          created: Math.floor(provider.createdAt / 1000),
          owned_by: provider.name,
        })
      }
    }
  }

  const config = storeManager.getConfig()
  const mappings = config.modelMappings || {}
  for (const [requestModel, mapping] of Object.entries(mappings)) {
    if (
      !addedModels.has(requestModel) &&
      loadBalancer.getAvailableAccountCount(requestModel, mapping.preferredProviderId) > 0
    ) {
      addedModels.add(requestModel)
      models.push({
        id: requestModel,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'model-mapping',
      })
    }
  }

  const response: ModelsResponse = {
    object: 'list',
    data: models,
  }

  ctx.set('Content-Type', 'application/json')
  ctx.body = response
})

/**
 * Get specified model info
 */
router.get('/models/:model', async (ctx: Context) => {
  const modelId = ctx.params.model

  const config = storeManager.getConfig()
  const mappings = config.modelMappings || {}
  if (mappings[modelId]) {
    const mapping = mappings[modelId]
    if (loadBalancer.getAvailableAccountCount(modelId, mapping.preferredProviderId) === 0) {
      ctx.status = 503
      ctx.body = {
        error: {
          message: `No healthy account is available for model '${modelId}'`,
          type: 'service_unavailable_error',
          param: 'model',
          code: 'no_available_account',
        },
      }
      return
    }
    ctx.set('Content-Type', 'application/json')
    ctx.body = {
      id: modelId,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'model-mapping',
    }
    return
  }

  const providers = storeManager.getProviders().filter((p) => p.enabled)

  for (const provider of providers) {
    const accounts = storeManager
      .getAccountsByProviderId(provider.id)
      .filter((account) => account.status === 'active')

    if (accounts.length === 0) {
      continue
    }

    const effectiveModels = storeManager.getEffectiveModels(provider.id)
    const normalizedModelId = modelId.toLowerCase()
    const found = effectiveModels.some((m) => {
      const normalizedSupported = m.displayName.toLowerCase()
      if (normalizedSupported.endsWith('*')) {
        return normalizedModelId.startsWith(normalizedSupported.slice(0, -1))
      }
      return normalizedSupported === normalizedModelId
    })

    if (found && loadBalancer.getAvailableAccountCount(modelId, provider.id) > 0) {
      ctx.set('Content-Type', 'application/json')
      ctx.body = {
        id: modelId,
        object: 'model',
        created: Math.floor(provider.createdAt / 1000),
        owned_by: provider.name,
      }
      return
    }
  }

  const deprecation = getModelDeprecation(modelId)
  ctx.status = deprecation ? 410 : 404
  ctx.body = {
    error: {
      message: deprecation?.message || `Model '${modelId}' not found`,
      type: 'invalid_request_error',
      param: 'model',
      code: deprecation ? 'model_deprecated' : 'model_not_found',
      ...(deprecation
        ? {
            details: {
              deprecated_model: deprecation.model,
              suggested_replacement: deprecation.replacement,
              requires_explicit_mapping: true,
            },
          }
        : {}),
    },
  }
})

export default router
