/**
 * JSON config-file egress source module.
 */
import { CONFIG_FILE_META } from './config.ts'
import { ConfigFileSource } from './source.ts'
import type { EgressSourceModule } from '../types.ts'

export const configFileSourceModule: EgressSourceModule = {
  meta: CONFIG_FILE_META,
  createSource: (services) => new ConfigFileSource(services),
}
