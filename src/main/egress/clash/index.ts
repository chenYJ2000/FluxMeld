/**
 * Clash/mihomo egress source module.
 */
import { CLASH_META } from './config.ts'
import { ClashSource } from './source.ts'
import type { EgressSourceModule } from '../types.ts'

export const clashSourceModule: EgressSourceModule = {
  meta: CLASH_META,
  createSource: (services) => new ClashSource(services),
}
