import axios, { AxiosError } from 'axios'
import type { TokenCheckResult } from '../types'

export const QWEN_AI_LEGACY_CREDENTIAL_ERROR =
  'Qwen 账号仍使用旧版加密凭据，请重新登录并更新 token 和 cookies'

export class QwenAiAuthenticationError extends Error {
  readonly status = 401

  constructor(message: string) {
    super(message)
    this.name = 'QwenAiAuthenticationError'
  }
}

export function getQwenAiCredentialError(token: string): string | null {
  if (!token) return 'Qwen token cannot be empty'
  if (token.startsWith('djEw')) return QWEN_AI_LEGACY_CREDENTIAL_ERROR
  try {
    if (token.split('.').length !== 3) return 'Invalid Qwen JWT token'
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return 'Invalid Qwen JWT token'
    }
    if (typeof payload.exp === 'number' && payload.exp * 1000 <= Date.now()) {
      return 'Qwen token has expired, please sign in again'
    }
  } catch {
    return 'Invalid Qwen JWT token'
  }
  return null
}

/** The current web session endpoint returns a user directly, not a v2 envelope. */
export function parseQwenAiAuthResponse(status: number, body: unknown): TokenCheckResult {
  if (status === 401 || status === 403)
    return { valid: false, error: 'Qwen token expired or invalid' }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { valid: false, error: `Invalid Qwen authentication response (HTTP ${status})` }
  }
  const data = body as Record<string, any>
  if (data.success === false || data.error) {
    return {
      valid: false,
      error:
        typeof data.data?.details === 'string' ? data.data.details : 'Qwen authentication failed',
    }
  }
  if (
    status !== 200 ||
    typeof data.id !== 'string' ||
    !data.id ||
    typeof data.email !== 'string' ||
    !data.email
  ) {
    return { valid: false, error: `Invalid Qwen authentication response (HTTP ${status})` }
  }
  if (data.role === 'guest' || data.email.endsWith('@guest.com')) {
    return { valid: false, error: 'Guest account not allowed, please login with a real account' }
  }
  return {
    valid: true,
    userInfo: { name: typeof data.name === 'string' ? data.name : data.email, email: data.email },
  }
}

export async function checkQwenAiCredentials(
  credentials: Record<string, string>,
): Promise<TokenCheckResult> {
  const token = credentials.token || credentials.accessToken || credentials.apiKey || ''
  const error = getQwenAiCredentialError(token)
  if (error) return { valid: false, error }
  try {
    const cookies = credentials.cookies || credentials.cookie
    const response = await axios.get('https://chat.qwen.ai/api/v1/auths/', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        source: 'web',
        ...(cookies ? { Cookie: cookies } : {}),
      },
      timeout: 15000,
      validateStatus: () => true,
    })
    return parseQwenAiAuthResponse(response.status, response.data)
  } catch (error) {
    return {
      valid: false,
      error: error instanceof AxiosError ? error.message : 'Qwen authentication request failed',
    }
  }
}
