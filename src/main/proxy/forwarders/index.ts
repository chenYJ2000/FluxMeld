/**
 * Provider forwarder registry facade.
 *
 * The actual registration lives in `providers/registry.ts` (backed by each
 * provider module). This module preserves the existing import surface for the
 * proxy orchestration layer.
 */

import { createProviderForwarders } from '../../providers/registry.ts'

export type { ForwarderServices, ProviderForwarder } from './types'
export { createForwardFailure, getForwardErrorStatus } from './errors'
export { createProviderForwarders }
