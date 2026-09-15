/**
 * OAuth Module Type Definitions
 * Defines types and interfaces for provider authentication
 */

import type { ProviderVendor } from '../../shared/types'

export type ProviderType = Exclude<ProviderVendor, 'custom'>

export type { ProviderVendor }

/**
 * Authentication method
 */
export type AuthMethod = 'oauth' | 'token' | 'cookie' | 'manual'

/**
 * OAuth login status
 */
export type OAuthStatus = 'idle' | 'pending' | 'success' | 'error' | 'cancelled'

/**
 * Token type
 */
export type TokenType = 'jwt' | 'refresh' | 'access' | 'cookie'

/**
 * OAuth login result
 */
export interface OAuthResult {
  success: boolean
  providerId?: string
  providerType?: ProviderType
  credentials?: Record<string, string>
  accountInfo?: OAuthAccountInfo
  error?: string
}

/**
 * OAuth account info
 */
export interface OAuthAccountInfo {
  userId?: string
  email?: string
  name?: string
  avatar?: string
  quota?: number
  used?: number
  expiresAt?: number
}

/**
 * OAuth login options
 */
export interface OAuthOptions {
  providerId: string
  providerType: ProviderType
  callbackPort?: number
  timeout?: number
}

/**
 * OAuth callback data
 */
export interface OAuthCallbackData {
  code?: string
  token?: string
  state?: string
  error?: string
  errorDescription?: string
}

/**
 * Token validation result
 */
export interface TokenValidationResult {
  valid: boolean
  tokenType?: TokenType
  expiresAt?: number
  accountInfo?: OAuthAccountInfo
  error?: string
}

/**
 * Credential info
 */
export interface CredentialInfo {
  type: TokenType
  value: string
  expiresAt?: number
  refreshToken?: string
  extra?: Record<string, string>
}

/**
 * Adapter config
 */
export interface AdapterConfig {
  providerId: string
  providerType: ProviderType
  authMethods: AuthMethod[]
  callbackPort: number
  loginUrl?: string
  apiUrl?: string
}

/**
 * OAuth progress event
 */
export interface OAuthProgressEvent {
  status: OAuthStatus
  message: string
  progress?: number
  data?: Record<string, unknown>
}
