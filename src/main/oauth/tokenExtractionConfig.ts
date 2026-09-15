/**
 * Token Extraction Configuration
 *
 * The types and the per-provider rules live with the provider plugin contracts;
 * each provider module owns its extraction config and exposes it through
 * `providers/registry.ts`.
 */

import type { ProviderType } from './types'
import type { TokenExtractionConfig } from '../providers/types.ts'
import { getProviderModule } from '../providers/registry.ts'

export type {
  TokenSourceType,
  TokenSource,
  TokenExtractionConfig,
} from '../providers/types.ts'

export function getTokenExtractionConfig(providerType: ProviderType): TokenExtractionConfig | null {
  return getProviderModule(providerType)?.tokenExtraction ?? null
}
