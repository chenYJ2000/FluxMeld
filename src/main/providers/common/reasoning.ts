/**
 * Shared reasoning-mode helper re-export.
 *
 * Providers import reasoning handling through this module so they depend only
 * on `providers/common` rather than reaching into `proxy/utils` directly.
 */

export { isReasoningEnabled } from '../../proxy/utils/reasoning.ts'
