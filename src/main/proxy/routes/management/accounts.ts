/**
 * Management API - Account Routes
 * Provides CRUD operations for account management
 */

import Router from '@koa/router'
import type { Context } from 'koa'
import { managementAuthMiddleware } from '../../middleware/managementAuth'
import AccountManager from '../../../store/accounts'
import { credentialsEqual, matchesAccountQuery } from '../../../../shared/accountBatch'
import type { 
  Account, 
  CreateAccountRequest, 
  UpdateAccountRequest,
  ManagementApiResponse,
  ValidationResult,
  BatchCreateAccountsRequest,
  BatchUpdateAccountsRequest,
  BatchDeleteAccountsRequest,
  AccountQueryRequest,
  BatchAccountResult,
  BatchAccountsResponse,
  BatchDeleteAccountsResponse,
  AccountsQueryResponse,
} from '../../../../../shared/types'

const router = new Router({ prefix: '/v0/management' })

/**
 * Mask sensitive credential fields
 * Replaces all credential values with '***' for security
 */
function maskCredentials(account: Account): Account {
  const maskedCredentials: Record<string, string> = {}
  for (const key of Object.keys(account.credentials)) {
    maskedCredentials[key] = '***'
  }
  
  return {
    ...account,
    credentials: maskedCredentials,
  }
}

/**
 * Create error response
 */
function createErrorResponse(code: string, message: string): ManagementApiResponse {
  return {
    success: false,
    error: {
      code,
      message,
    },
  }
}

/**
 * Create success response
 */
function createSuccessResponse<T>(data: T): ManagementApiResponse<T> {
  return {
    success: true,
    data,
  }
}

/**
 * GET /v0/management/accounts
 * List all accounts (credentials masked)
 */
router.get('/accounts', managementAuthMiddleware, async (ctx: Context) => {
  try {
    const accounts = AccountManager.getAll(false)
    const maskedAccounts = accounts.map(maskCredentials)
    
    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse(maskedAccounts)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to get accounts'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

/**
 * GET /v0/management/providers/:providerId/accounts
 * List accounts by provider (credentials masked)
 */
router.get('/providers/:providerId/accounts', managementAuthMiddleware, async (ctx: Context) => {
  try {
    const providerId = ctx.params.providerId
    const accounts = AccountManager.getByProviderId(providerId, false)
    const maskedAccounts = accounts.map(maskCredentials)
    
    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse(maskedAccounts)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to get accounts by provider'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

/**
 * GET /v0/management/accounts/:id
 * Get account by ID (credentials masked)
 * Returns 404 if account not found
 */
router.get('/accounts/:id', managementAuthMiddleware, async (ctx: Context) => {
  try {
    const id = ctx.params.id
    const account = AccountManager.getById(id, false)
    
    if (!account) {
      ctx.status = 404
      ctx.body = createErrorResponse('account_not_found', `Account not found: ${id}`)
      return
    }
    
    const maskedAccount = maskCredentials(account)
    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse(maskedAccount)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to get account'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

/**
 * POST /v0/management/accounts
 * Create new account
 */
router.post('/accounts', managementAuthMiddleware, async (ctx: Context) => {
  try {
    const request = ctx.request.body as CreateAccountRequest
    
    if (!request.providerId) {
      ctx.status = 400
      ctx.body = createErrorResponse('invalid_request', 'Missing required field: providerId')
      return
    }
    
    if (!request.name) {
      ctx.status = 400
      ctx.body = createErrorResponse('invalid_request', 'Missing required field: name')
      return
    }
    
    if (!request.credentials || typeof request.credentials !== 'object') {
      ctx.status = 400
      ctx.body = createErrorResponse('invalid_request', 'Missing or invalid required field: credentials')
      return
    }
    
    const account = AccountManager.create({
      providerId: request.providerId,
      name: request.name,
      email: request.email,
      credentials: request.credentials,
      dailyLimit: request.dailyLimit,
    })
    
    const maskedAccount = maskCredentials(account)
    ctx.status = 201
    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse(maskedAccount)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to create account'
    
    if (errorMessage.includes('not found')) {
      ctx.status = 404
      ctx.body = createErrorResponse('provider_not_found', errorMessage)
    } else {
      ctx.status = 500
      ctx.body = createErrorResponse('internal_error', errorMessage)
    }
  }
})

/**
 * PUT /v0/management/accounts/:id
 * Update account
 */
router.put('/accounts/:id', managementAuthMiddleware, async (ctx: Context) => {
  try {
    const id = ctx.params.id
    const request = ctx.request.body as UpdateAccountRequest
    
    const existingAccount = AccountManager.getById(id, false)
    if (!existingAccount) {
      ctx.status = 404
      ctx.body = createErrorResponse('account_not_found', `Account not found: ${id}`)
      return
    }
    
    const updates: Partial<Omit<Account, 'id' | 'createdAt'>> = {}
    
    if (request.name !== undefined) {
      updates.name = request.name
    }
    
    if (request.email !== undefined) {
      updates.email = request.email
    }
    
    if (request.credentials !== undefined) {
      updates.credentials = request.credentials
    }
    
    if (request.dailyLimit !== undefined) {
      updates.dailyLimit = request.dailyLimit
    }
    
    const updatedAccount = AccountManager.update(id, updates)
    
    if (!updatedAccount) {
      ctx.status = 500
      ctx.body = createErrorResponse('update_failed', 'Failed to update account')
      return
    }
    
    const maskedAccount = maskCredentials(updatedAccount)
    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse(maskedAccount)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to update account'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

/**
 * DELETE /v0/management/accounts/:id
 * Delete account
 */
router.delete('/accounts/:id', managementAuthMiddleware, async (ctx: Context) => {
  try {
    const id = ctx.params.id
    
    const deleted = AccountManager.delete(id)
    
    if (!deleted) {
      ctx.status = 404
      ctx.body = createErrorResponse('account_not_found', `Account not found: ${id}`)
      return
    }
    
    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse({ id, deleted: true })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to delete account'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

/**
 * POST /v0/management/accounts/:id/validate
 * Validate account credentials
 */
router.post('/accounts/:id/validate', managementAuthMiddleware, async (ctx: Context) => {
  try {
    const id = ctx.params.id
    
    const existingAccount = AccountManager.getById(id, false)
    if (!existingAccount) {
      ctx.status = 404
      ctx.body = createErrorResponse('account_not_found', `Account not found: ${id}`)
      return
    }
    
    const validationResult: ValidationResult = await AccountManager.validate(id)
    
    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse(validationResult)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to validate account'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

/**
 * POST /v0/management/accounts/batch
 * Batch create accounts. Strict: an account whose providerId and credentials
 * exactly match an existing account is rejected with `duplicate_account`.
 */
router.post('/accounts/batch', managementAuthMiddleware, async (ctx: Context) => {
  try {
    const request = ctx.request.body as BatchCreateAccountsRequest
    const items = Array.isArray(request?.accounts) ? request.accounts : null

    if (!items) {
      ctx.status = 400
      ctx.body = createErrorResponse('invalid_request', 'Missing or invalid required field: accounts (array)')
      return
    }

    const results: BatchAccountResult[] = []
    let succeeded = 0
    let failed = 0

    for (let index = 0; index < items.length; index++) {
      const item = items[index]
      try {
        if (!item || !item.providerId) {
          throw new Error('Missing required field: providerId')
        }
        if (!item.name) {
          throw new Error('Missing required field: name')
        }
        if (!item.credentials || typeof item.credentials !== 'object') {
          throw new Error('Missing or invalid required field: credentials')
        }

        const existing = AccountManager.getByProviderId(item.providerId, true)
        const duplicate = existing.find((account) => credentialsEqual(account.credentials, item.credentials))
        if (duplicate) {
          results.push({
            index,
            success: false,
            error: {
              code: 'duplicate_account',
              message: `Account with identical credentials already exists: ${duplicate.id}`,
            },
          })
          failed++
          continue
        }

        const account = AccountManager.create({
          providerId: item.providerId,
          name: item.name,
          email: item.email,
          credentials: item.credentials,
          dailyLimit: item.dailyLimit,
        })

        results.push({ index, success: true, account: maskCredentials(account) })
        succeeded++
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to create account'
        const code = message.includes('not found') ? 'provider_not_found' : 'create_failed'
        results.push({ index, success: false, error: { code, message } })
        failed++
      }
    }

    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse<BatchAccountsResponse>({
      total: items.length,
      succeeded,
      failed,
      results,
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to batch create accounts'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

/**
 * POST /v0/management/accounts/batch/update
 * Batch update accounts matched by internal id.
 */
router.post('/accounts/batch/update', managementAuthMiddleware, async (ctx: Context) => {
  try {
    const request = ctx.request.body as BatchUpdateAccountsRequest
    const items = Array.isArray(request?.updates) ? request.updates : null

    if (!items) {
      ctx.status = 400
      ctx.body = createErrorResponse('invalid_request', 'Missing or invalid required field: updates (array)')
      return
    }

    const results: BatchAccountResult[] = []
    let succeeded = 0
    let failed = 0

    for (let index = 0; index < items.length; index++) {
      const item = items[index]
      try {
        if (!item || !item.id) {
          throw new Error('Missing required field: id')
        }

        const existing = AccountManager.getById(item.id, false)
        if (!existing) {
          results.push({
            index,
            success: false,
            id: item.id,
            error: { code: 'account_not_found', message: `Account not found: ${item.id}` },
          })
          failed++
          continue
        }

        const updates: Partial<Omit<Account, 'id' | 'createdAt'>> = {}
        if (item.name !== undefined) updates.name = item.name
        if (item.email !== undefined) updates.email = item.email
        if (item.credentials !== undefined) updates.credentials = item.credentials
        if (item.dailyLimit !== undefined) updates.dailyLimit = item.dailyLimit
        if (item.status !== undefined) updates.status = item.status

        const updated = AccountManager.update(item.id, updates)
        if (!updated) {
          throw new Error('Failed to update account')
        }

        results.push({ index, success: true, account: maskCredentials(updated) })
        succeeded++
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to update account'
        results.push({ index, success: false, id: item?.id, error: { code: 'update_failed', message } })
        failed++
      }
    }

    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse<BatchAccountsResponse>({
      total: items.length,
      succeeded,
      failed,
      results,
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to batch update accounts'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

/**
 * POST /v0/management/accounts/batch/delete
 * Batch delete accounts by explicit ids and/or every account of a provider.
 */
router.post('/accounts/batch/delete', managementAuthMiddleware, async (ctx: Context) => {
  try {
    const request = (ctx.request.body || {}) as BatchDeleteAccountsRequest
    const ids = Array.isArray(request.ids)
      ? request.ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : []
    const providerId = typeof request.providerId === 'string' && request.providerId.length > 0
      ? request.providerId
      : undefined

    if (ids.length === 0 && !providerId) {
      ctx.status = 400
      ctx.body = createErrorResponse('invalid_request', 'Provide at least one of: ids, providerId')
      return
    }

    const targetIds = [...new Set(ids)]
    if (providerId) {
      for (const account of AccountManager.getByProviderId(providerId, false)) {
        if (!targetIds.includes(account.id)) {
          targetIds.push(account.id)
        }
      }
    }

    const results: BatchAccountResult[] = []
    let succeeded = 0
    let failed = 0

    targetIds.forEach((id, index) => {
      const deleted = AccountManager.delete(id)
      if (deleted) {
        results.push({ index, success: true, id })
        succeeded++
      } else {
        results.push({
          index,
          success: false,
          id,
          error: { code: 'account_not_found', message: `Account not found: ${id}` },
        })
        failed++
      }
    })

    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse<BatchDeleteAccountsResponse>({
      total: targetIds.length,
      succeeded,
      failed,
      deletedCount: succeeded,
      results,
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to batch delete accounts'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

/**
 * POST /v0/management/accounts/query
 * Query accounts with optional filters. Credentials are masked unless
 * `includeCredentials` is true.
 */
router.post('/accounts/query', managementAuthMiddleware, async (ctx: Context) => {
  try {
    const query = (ctx.request.body || {}) as AccountQueryRequest
    const includeCredentials = query.includeCredentials === true

    const all = AccountManager.getAll(includeCredentials)
    const matched = all.filter((account) => matchesAccountQuery(account, query))
    const items = includeCredentials ? matched : matched.map(maskCredentials)

    ctx.set('Content-Type', 'application/json')
    ctx.body = createSuccessResponse<AccountsQueryResponse>({
      total: items.length,
      items,
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to query accounts'
    ctx.status = 500
    ctx.body = createErrorResponse('internal_error', errorMessage)
  }
})

export default router
