/**
 * JSON config-file egress source.
 *
 * Reads a local JSON file listing proxy entries and exposes each entry as an
 * exit. No source-side action is required to activate an exit; rotation is
 * handled by the shared allocator over `listExits()`.
 */

import { existsSync } from 'node:fs'
import { CONFIG_FILE_META } from './config.ts'
import { readExitFile } from './parser.ts'
import type {
  EgressExit,
  EgressProbeResult,
  EgressServices,
  EgressSource,
  EgressSourceModuleMeta,
} from '../types.ts'

export class ConfigFileSource implements EgressSource {
  readonly meta: EgressSourceModuleMeta = CONFIG_FILE_META

  constructor(private readonly services: EgressServices) {}

  private getFilePath(): string {
    const settings = this.services.getSettings()
    return String(settings.filePath ?? '').trim()
  }

  async probe(): Promise<EgressProbeResult> {
    const filePath = this.getFilePath()
    if (!filePath) {
      return { available: false, error: 'No config file path configured.' }
    }
    if (!existsSync(filePath)) {
      return { available: false, error: `Config file not found: ${filePath}` }
    }
    try {
      const exits = readExitFile(filePath)
      if (exits.length === 0) {
        return { available: false, error: 'Config file contains no valid exit entries.' }
      }
      return { available: true, details: { filePath, exitCount: exits.length } }
    } catch (error) {
      return {
        available: false,
        error: `Failed to read config file: ${error instanceof Error ? error.message : 'unknown error'}`,
      }
    }
  }

  async listExits(): Promise<EgressExit[]> {
    const filePath = this.getFilePath()
    if (!filePath || !existsSync(filePath)) return []
    try {
      return readExitFile(filePath)
    } catch {
      return []
    }
  }

  async apply(): Promise<boolean> {
    return true
  }

  async deactivate(): Promise<void> {
    // Nothing source-side to restore.
  }
}
