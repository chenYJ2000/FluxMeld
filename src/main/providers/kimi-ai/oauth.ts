import { BaseOAuthAdapter } from '../common/oauthBase'
import type {
  AdapterConfig,
  OAuthOptions,
  OAuthResult,
  TokenValidationResult,
  CredentialInfo,
} from '../../oauth/types'
import type { Account, Provider } from '../../../shared/types'
import { checkKimiAiToken } from './tokenCheck'
import { exchangeKimiAiRefreshToken, getKimiAiJwtExpiry, KIMI_AI_BASE } from './session'

export class KimiAiOAuthAdapter extends BaseOAuthAdapter {
  constructor(config: AdapterConfig) {
    super({
      ...config,
      providerType: 'kimi-ai',
      authMethods: ['manual', 'token'],
      loginUrl: KIMI_AI_BASE,
      apiUrl: KIMI_AI_BASE,
    })
  }

  async startLogin(options: OAuthOptions): Promise<OAuthResult> {
    await this.openBrowser(KIMI_AI_BASE)
    return {
      success: false,
      providerId: options.providerId,
      providerType: 'kimi-ai',
      error: 'Copy access_token and refresh_token from www.kimi.ai Local Storage',
    }
  }

  async validateToken(credentials: Record<string, string>): Promise<TokenValidationResult> {
    const result = await checkKimiAiToken(
      { id: 'kimi-ai' } as Provider,
      {
        id: 'temp',
        providerId: 'kimi-ai',
        name: 'temp',
        credentials: {
          token: credentials.token || credentials.access_token || '',
          refresh_token: credentials.refresh_token || '',
        },
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as Account,
    )
    return {
      valid: result.valid,
      tokenType: 'jwt',
      accountInfo: result.userInfo,
      error: result.error,
    }
  }

  async refreshToken(credentials: Record<string, string>): Promise<CredentialInfo | null> {
    const refresh = credentials.refresh_token
    if (!refresh) return null
    try {
      const next = await exchangeKimiAiRefreshToken(refresh)
      return {
        type: 'jwt',
        value: next.token,
        refreshToken: next.refresh_token,
        expiresAt: getKimiAiJwtExpiry(next.token) || undefined,
      }
    } catch {
      return null
    }
  }
}

export default KimiAiOAuthAdapter
