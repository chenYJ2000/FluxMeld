import type { RequestLogConfig } from '../store/types.ts'

export type { RequestLogConfig } from '../store/types.ts'

export interface RequestLogFilter {
  status?: 'success' | 'error'
  providerId?: string
  /** API-key label (configured key name, or raw key when unmatched) */
  apiKey?: string
  /** Requested model name */
  model?: string
  /** Max number of entries to return */
  limit?: number
  /** Number of entries to skip (pagination) */
  offset?: number
}

export interface RequestLogFilterOptions {
  apiKeys: string[]
  models: string[]
}

export interface RequestLogStats {
  total: number
  success: number
  error: number
  todayTotal: number
  todaySuccess: number
  todayError: number
}

export interface RequestLogTrendPoint {
  date: string
  total: number
  success: number
  error: number
  avgLatency: number
}

export function normalizeRequestLogConfig(config?: Partial<RequestLogConfig>): RequestLogConfig {
  return {
    enabled: true,
    maxEntries: 200,
    includeBodies: false,
    maxBodyChars: 8000,
    redactSensitiveData: true,
    ...config,
  }
}
