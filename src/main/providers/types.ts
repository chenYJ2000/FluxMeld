/**
 * Provider Plugin Contracts
 *
 * A `ProviderModule` is the single, self-contained entry point for one AI
 * provider. It bundles everything provider-specific (config, OAuth, proxy
 * adapter, forwarder, token check, tool profile, capabilities, UI metadata)
 * so that adding or changing a provider never requires editing shared
 * orchestration code.
 *
 * Shared orchestrators (proxy forwarder, OAuth manager, IPC handlers, store)
 * consume providers exclusively through `providers/registry.ts`.
 */

import type { Account, Provider, CredentialField } from '../../shared/types'
import type { BaseOAuthAdapter } from './common/oauthBase'
import type { AdapterConfig, ProviderType } from '../oauth/types'
import type { ForwarderServices, ProviderForwarder } from '../proxy/forwarders/types'
import type { ProviderToolProfile } from '../proxy/toolCalling/providerProfiles'

/**
 * Where an in-app-login token can be sourced from.
 */
export type TokenSourceType = 'networkHeader' | 'localStorage' | 'cookie'

export interface TokenSource {
  type: TokenSourceType
  key: string
  urlPattern?: string
  extractPattern?: string
}

/**
 * Rules describing how to extract credentials during in-app browser login.
 */
export interface TokenExtractionConfig {
  loginUrl: string
  tokenSources: TokenSource[]
  targetDomains: string[]
  successUrlPatterns?: RegExp[]
  windowTitle?: string
}

/**
 * A form field the registration assistant should populate.
 *
 * `selector` is optional; when omitted the shared autofill falls back to
 * heuristics so the flow keeps working when the page markup changes.
 */
export interface RegistrationField {
  value: 'phone' | 'password' | 'code'
  selector?: string
}

/**
 * Rules for assisting account registration in the in-app browser window.
 *
 * This only opens the provider's official page and prefills the phone and
 * password so the repetitive typing is not repeated per account. The captcha
 * / slider and the SMS verification code are always completed by a human.
 */
export interface RegistrationConfig {
  /** Official registration/login page to open. */
  registrationUrl: string
  /** Fields to autofill. Defaults to the phone + password heuristics. */
  fields?: RegistrationField[]
  /** Window title shown while registering. */
  windowTitle?: string
}

/**
 * Built-in Provider Configuration Interface
 *
 * Static, serializable description of a provider. This is the single source of
 * truth synced into persistent storage by `StoreManager.initializeDefaultProviders`.
 */
export interface BuiltinProviderConfig extends Omit<Provider, 'createdAt' | 'updatedAt'> {
  /** Credential field configuration */
  credentialFields: CredentialField[]
  /** Token check endpoint */
  tokenCheckEndpoint?: string
  /** Token check method */
  tokenCheckMethod?: 'GET' | 'POST'
  /** Models list API endpoint for dynamic model fetching */
  modelsApiEndpoint?: string
  /** Additional headers for models API request */
  modelsApiHeaders?: Record<string, string>
}

/**
 * Result of validating a single account credential.
 */
export interface TokenCheckResult {
  valid: boolean
  error?: string
  userInfo?: {
    name?: string
    email?: string
    quota?: number
    used?: number
  }
}

/**
 * Provider usage credits (currently only MiniMax reports them).
 */
export interface ProviderCreditsInfo {
  totalCredits: number
  usedCredits: number
  remainingCredits: number
  /** Credit reset timestamp (milliseconds) */
  expiresAt?: number
}

/**
 * Extra operations a provider may implement. Declared as functions here and
 * surfaced to the renderer/store as boolean flags (see `ProviderCapabilities`).
 */
export interface ProviderCapabilityHandlers {
  clearChats?(provider: Provider, account: Account): Promise<boolean>
  credits?(provider: Provider, account: Account): Promise<ProviderCreditsInfo | null>
}

/**
 * OAuth integration for a provider.
 */
export interface ProviderOAuthModule {
  factory(config: AdapterConfig): BaseOAuthAdapter
  authMethods: string[]
}

/**
 * The single plugin contract for a provider.
 */
export interface ProviderModule {
  /** Provider vendor id; must match `ProviderVendor`. */
  id: ProviderType
  /** Static provider configuration. */
  config: BuiltinProviderConfig
  /** Whether this module owns the given provider record. */
  matches(provider: Provider): boolean
  /** Forwarding strategy factory (required — every provider needs one). */
  createForwarder(services: ForwarderServices): ProviderForwarder
  /** OAuth adapter factory + supported auth methods. */
  oauth?: ProviderOAuthModule
  /** In-app browser token extraction rules. */
  tokenExtraction?: TokenExtractionConfig
  /** Assisted registration rules (official page + phone/password prefill). */
  registration?: RegistrationConfig
  /** Credential validation for an account. */
  tokenChecker?(
    provider: Provider,
    account: Account,
  ): Promise<TokenCheckResult> | TokenCheckResult
  /** Normalize raw OAuth credentials into canonical provider credential keys. */
  normalizeOAuthCredentials?(credentials: Record<string, string>): Record<string, string>
  /** Optional provider capabilities (clear chats, credits, ...). */
  capabilities?: ProviderCapabilityHandlers
  /** Tool-calling profile for models without native function calling. */
  toolProfile?: ProviderToolProfile
}
