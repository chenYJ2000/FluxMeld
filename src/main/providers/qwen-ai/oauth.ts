/**
 * Qwen AI (International) Authentication Adapter
 * Implements chat.qwen.ai API authentication
 */

import axios from 'axios'
import { BaseOAuthAdapter } from '../common/oauthBase'
import { checkQwenAiCredentials, parseQwenAiAuthResponse } from './auth'
import { exchangeQwenAiRefreshToken, getQwenAiJwtExpiry } from './session'
import {
  OAuthResult,
  TokenValidationResult,
  CredentialInfo,
  AdapterConfig,
  OAuthCallbackData,
} from '../../oauth/types'

const QWEN_AI_API_BASE = 'https://chat.qwen.ai'

const FAKE_HEADERS = {
  Accept: 'application/json',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Cache-Control': 'no-cache',
  Origin: QWEN_AI_API_BASE,
  Pragma: 'no-cache',
  'Sec-Ch-Ua': '"Chromium";v="144", "Not(A:Brand";v="8", "Google Chrome";v="144"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
  source: 'web',
}

export class QwenAiAdapter extends BaseOAuthAdapter {
  constructor(config: AdapterConfig) {
    super({
      ...config,
      providerType: 'qwen-ai',
      authMethods: ['manual'],
      loginUrl: QWEN_AI_API_BASE,
      apiUrl: QWEN_AI_API_BASE,
    })
  }

  async loginWithToken(providerId: string, token: string): Promise<OAuthResult> {
    this.emitProgress('pending', 'Validating Token...')

    try {
      const validation = await this.validateToken({ token })

      if (!validation.valid) {
        return {
          success: false,
          providerId,
          providerType: 'qwen-ai',
          error: validation.error || 'Token validation failed',
        }
      }

      this.emitProgress('success', 'Token validation successful')

      return {
        success: true,
        providerId,
        providerType: 'qwen-ai',
        credentials: { token },
        accountInfo: validation.accountInfo,
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Validation request failed'
      return {
        success: false,
        providerId,
        providerType: 'qwen-ai',
        error: errorMessage,
      }
    }
  }

  protected async processCallback(_data: OAuthCallbackData): Promise<void> {
    // Qwen AI does not support OAuth callback
  }

  async validateToken(credentials: Record<string, string>): Promise<TokenValidationResult> {
    const validation = await checkQwenAiCredentials(credentials)
    if (!validation.valid) return { valid: false, error: validation.error }

    const token = credentials.token || credentials.accessToken || credentials.apiKey
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
    return {
      valid: true,
      tokenType: 'access',
      expiresAt: (getQwenAiJwtExpiry(token) ?? 0) * 1000 || undefined,
      accountInfo: {
        userId: payload.sub || payload.id || payload.user_id || payload.uid,
        email: validation.userInfo?.email || '',
        name: validation.userInfo?.name || validation.userInfo?.email || '',
      },
    }
  }

  async getUserInfo(token: string): Promise<Record<string, unknown> | null> {
    try {
      const response = await axios.get(`${QWEN_AI_API_BASE}/api/v1/auths/`, {
        headers: {
          Authorization: `Bearer ${token}`,
          ...FAKE_HEADERS,
        },
        timeout: 15000,
        validateStatus: () => true,
      })

      if (!parseQwenAiAuthResponse(response.status, response.data).valid) {
        return null
      }

      return response.data
    } catch {
      return null
    }
  }

  async refreshToken(credentials: Record<string, string>): Promise<CredentialInfo | null> {
    const refreshed = await exchangeQwenAiRefreshToken(credentials)
    return {
      type: 'access',
      value: refreshed.token,
      expiresAt: (getQwenAiJwtExpiry(refreshed.token) ?? 0) * 1000 || undefined,
      refreshToken: refreshed.refresh_token,
      extra: refreshed,
    }
  }
}

export default QwenAiAdapter
