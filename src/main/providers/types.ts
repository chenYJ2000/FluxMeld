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
import type { AdapterConfig, OAuthResult, ProviderType } from '../oauth/types'
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
  /**
   * Also persist the browser cookie jar for `targetDomains` as
   * `credentials.cookies`. Needed by providers whose API endpoints reject
   * requests that lack the site's anti-bot cookies even when the token is valid
   * (e.g. Qwen AI's Aliyun WAF).
   */
  collectCookies?: boolean
  /** Token keys that must be collected before the login is validated. */
  requiredKeys?: string[]
  /** Legacy credential sets accepted for login, but never for registration. */
  loginAlternativeKeys?: string[][]
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
  value: 'phone' | 'password' | 'code' | 'email'
  selector?: string
}

/**
 * Rules for assisting account registration in the in-app browser window.
 *
 * Opens the provider's official page and prefills the configured fields.
 * Optional selectors can send and submit an SMS code; a human still handles
 * any challenge presented by the provider.
 */
export interface RegistrationConfig {
  /** Official registration/login page to open. */
  registrationUrl: string
  /** Fields to autofill. Defaults to the phone + password heuristics. */
  fields?: RegistrationField[]
  /** Window title shown while registering. */
  windowTitle?: string
  /**
   * How the verification code is obtained.
   * - `sms` (default): lease a phone number from the company number API.
   * - `email`: create a disposable inbox from the email API and read the code.
   */
  codeSource?: 'sms' | 'email'
  /**
   * Force a direct (proxy-less) connection for the registration window. Some
   * providers (e.g. Qwen AI) reset TLS when routed through a system proxy, so
   * their signup page only loads when connected directly.
   */
  forceDirectConnection?: boolean
  /** Require the operator to accept the provider's terms before a batch starts. */
  requiresTermsConsent?: boolean
  /** Optional controls for providers whose SMS login can be submitted automatically. */
  termsCheckboxSelector?: string
  sendCodeSelector?: string
  submitSelector?: string
  /**
   * Selector for segmented code inputs (one box per digit, e.g. Qwen AI's
   * `qwenchat-verification-code-inp`). When set, the code is typed box by box.
   */
  codeSegmentedSelector?: string
  /**
   * Text of a tab/link to activate before filling (e.g. Aliyun's "手机号登录"
   * among 账密登录/手机号登录/通行密钥). The flow clicks the first element whose
   * text matches exactly; purely declarative so no provider-id branch is needed.
   */
  activateTabText?: string
  /**
   * SMS sender keyword passed to the number API (`getPhone` / `getMsg`).
   * Falls back to the global `registrationApi.keyWord` when omitted. Lets one
   * number API serve every provider without the operator re-editing the global
   * keyword before each run.
   */
  smsKeyword?: string
  /**
   * Whether this provider's signup form needs an explicit country/region code
   * (e.g. an international site). When true the dialog asks for it and the main
   * process forwards it to the flow.
   */
  needsCountryCode?: boolean
  /** Default country code prefilled in the dialog when `needsCountryCode`. */
  defaultCountryCode?: string
  /**
   * Legal links shown next to the terms checkbox, as label keys whose values are
   * URLs. Purely declarative so the dialog never branches on a provider id.
   */
  termsLinks?: Array<{ labelKey: string; url: string }>
  /**
   * Generate a random password for this provider's signup form. Defaults to true
   * when `fields` contains a password field.
   */
  generatePassword?: boolean
  /**
   * Human-readable note key shown under the count input (e.g. "SMS code is
   * required for this provider"). Falls back to the generic auto/manual hint.
   */
  codeHintKey?: string
  /** i18n key for the description shown at the top of the batch dialog. */
  descriptionKey?: string
}

/** Server-side browser registration for the headless web runtime. */
export interface WebRegistrationOptions {
  providerId: string
  phone: string
  /** Email address for email-based registration flows (empty for SMS). */
  email?: string
  /** Generated password for providers that still offer a password signup form. */
  password?: string
  countryCode: string
  timeout?: number
  resolveCode: (signal: AbortSignal) => Promise<string | null>
  signal: AbortSignal
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
  /** Optional web-runtime registration driver. It must close its browser on every exit. */
  webRegistration?(options: WebRegistrationOptions): Promise<OAuthResult>
  /** Credential validation for an account. */
  tokenChecker?(provider: Provider, account: Account): Promise<TokenCheckResult> | TokenCheckResult
  /** Optional periodic upkeep for persisted provider sessions. */
  maintainSessions?(): Promise<void>
  /** Normalize raw OAuth credentials into canonical provider credential keys. */
  normalizeOAuthCredentials?(credentials: Record<string, string>): Record<string, string>
  /** Optional provider capabilities (clear chats, credits, ...). */
  capabilities?: ProviderCapabilityHandlers
  /** Tool-calling profile for models without native function calling. */
  toolProfile?: ProviderToolProfile
}
