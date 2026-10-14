/**
 * Doubao authentication adapter.
 *
 * Doubao has no OAuth flow: an account is the browser-session credential bundle
 * captured manually from www.doubao.com. The adapter therefore only supports the
 * manual auth method and validates that every required field is present.
 */

import { shell } from 'electron'
import { BaseOAuthAdapter } from '../common/oauthBase'
import { DoubaoAdapter } from './adapter'
import {
  OAuthResult,
  OAuthOptions,
  TokenValidationResult,
  CredentialInfo,
  AdapterConfig,
  OAuthCallbackData,
} from '../../oauth/types'

const DOUBAO_WEB_URL = 'https://www.doubao.com'

export class DoubaoAdapterOAuth extends BaseOAuthAdapter {
  constructor(config: AdapterConfig) {
    super({
      ...config,
      providerType: 'doubao',
      authMethods: ['manual'],
      loginUrl: DOUBAO_WEB_URL,
      apiUrl: DOUBAO_WEB_URL,
    })
  }

  async startLogin(options: OAuthOptions): Promise<OAuthResult> {
    this.emitProgress('pending', 'Opening Doubao...')
    try {
      await shell.openExternal(DOUBAO_WEB_URL)
      this.emitProgress('pending', 'Log in, then paste the session credentials manually')
      return {
        success: false,
        providerId: options.providerId,
        providerType: 'doubao',
        error:
          'Log in at www.doubao.com, capture the session credentials from DevTools, and paste them manually',
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to open browser'
      this.emitProgress('error', message)
      return {
        success: false,
        providerId: options.providerId,
        providerType: 'doubao',
        error: message,
      }
    }
  }

  protected async processCallback(_data: OAuthCallbackData): Promise<void> {
    // Doubao does not support an OAuth callback.
  }

  async validateToken(credentials: Record<string, string>): Promise<TokenValidationResult> {
    const missing = DoubaoAdapter.missingCredentials(credentials)
    if (missing.length) {
      return { valid: false, error: `缺少必要凭据：${missing.join(', ')}` }
    }
    return { valid: true, tokenType: 'cookie' }
  }

  async refreshToken(_credentials: Record<string, string>): Promise<CredentialInfo | null> {
    // Doubao session credentials cannot be refreshed programmatically.
    return null
  }
}

export default DoubaoAdapterOAuth
