/**
 * IP pool egress source module.
 */
import { IP_POOL_META } from './config.ts'
import { IpPoolSource } from './source.ts'
import type { EgressSourceModule } from '../types.ts'

export const ipPoolSourceModule: EgressSourceModule = {
  meta: IP_POOL_META,
  createSource: (services) => new IpPoolSource(services),
}
