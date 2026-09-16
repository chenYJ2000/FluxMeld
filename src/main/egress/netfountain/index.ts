/**
 * NetFountain egress source module.
 */
import { NETFOUNTAIN_META } from './config.ts'
import { NetFountainSource } from './source.ts'
import type { EgressSourceModule } from '../types.ts'

export const netFountainSourceModule: EgressSourceModule = {
  meta: NETFOUNTAIN_META,
  createSource: (services) => new NetFountainSource(services),
}
