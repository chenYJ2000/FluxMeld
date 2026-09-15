import type { RequestLogEntry } from '../store/types.ts'
import type { RequestLogConfig } from './types.ts'

export function sanitizeRequestLogEntry(
  entry: Omit<RequestLogEntry, 'id'>,
  config: RequestLogConfig,
): Omit<RequestLogEntry, 'id'> {
  const sanitized: Omit<RequestLogEntry, 'id'> = {
    ...entry,
    userInput: sanitizeUserInput(entry.userInput, config),
    errorStack: undefined,
  }

  if (!config.includeBodies) {
    sanitized.requestBody = undefined
    sanitized.responseBody = undefined
    sanitized.responsePreview = truncateText(entry.responsePreview, 1000)
    sanitized.errorMessage = truncateText(entry.errorMessage, 1000)
    return sanitized
  }

  sanitized.requestBody = sanitizeRequestLogBody(entry.requestBody, config)
  sanitized.responseBody = sanitizeRequestLogBody(entry.responseBody, config)
  sanitized.responsePreview = truncateText(entry.responsePreview, 1000)
  sanitized.errorMessage = truncateText(entry.errorMessage, 1000)

  return sanitized
}

export function sanitizeRequestLogUpdates(
  updates: Partial<RequestLogEntry>,
  config: RequestLogConfig,
): Partial<RequestLogEntry> {
  const sanitized: Partial<RequestLogEntry> = { ...updates }

  // Updates are patches. Do not add undefined properties for fields that were
  // not supplied, otherwise a response-body update at the end of a stream
  // erases the user input and other metadata captured when the request began.
  if (hasOwn(updates, 'userInput')) {
    sanitized.userInput = sanitizeUserInput(updates.userInput, config)
  }
  if (hasOwn(updates, 'errorStack')) {
    sanitized.errorStack = undefined
  }

  if (!config.includeBodies) {
    if (hasOwn(updates, 'requestBody')) sanitized.requestBody = undefined
    if (hasOwn(updates, 'responseBody')) sanitized.responseBody = undefined
    if (hasOwn(updates, 'responsePreview')) {
      sanitized.responsePreview = truncateText(updates.responsePreview, 1000)
    }
    if (hasOwn(updates, 'errorMessage')) {
      sanitized.errorMessage = truncateText(updates.errorMessage, 1000)
    }
    return sanitized
  }

  if (hasOwn(updates, 'requestBody')) {
    sanitized.requestBody = sanitizeRequestLogBody(updates.requestBody, config)
  }
  if (hasOwn(updates, 'responseBody')) {
    sanitized.responseBody = sanitizeRequestLogBody(updates.responseBody, config)
  }
  if (hasOwn(updates, 'responsePreview')) {
    sanitized.responsePreview = truncateText(updates.responsePreview, 1000)
  }
  if (hasOwn(updates, 'errorMessage')) {
    sanitized.errorMessage = truncateText(updates.errorMessage, 1000)
  }

  return sanitized
}

export function trimRequestLogsToMaxEntries(
  entries: RequestLogEntry[],
  config: RequestLogConfig,
): RequestLogEntry[] {
  const maxEntries = Math.max(0, config.maxEntries)
  if (maxEntries === 0) {
    return []
  }

  if (entries.length <= maxEntries) {
    return entries
  }

  return entries.slice(entries.length - maxEntries)
}

function sanitizeRequestLogBody(
  value: string | undefined,
  config: RequestLogConfig,
): string | undefined {
  if (!value) return value

  const redacted = config.redactSensitiveData ? redactSensitiveText(value) : value
  return truncateText(redacted, config.maxBodyChars)
}

function sanitizeUserInput(
  value: string | undefined,
  config: RequestLogConfig,
): string | undefined {
  if (!value) return value
  const redacted = config.redactSensitiveData ? redactSensitiveText(value) : value
  return truncateText(redacted, 500)
}

function hasOwn<T extends object>(value: T, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function truncateText(value: string | undefined, maxChars: number): string | undefined {
  if (!value) return value
  if (maxChars <= 0) return undefined
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars)}...[truncated ${value.length - maxChars} chars]`
}

function redactSensitiveText(value: string): string {
  return value.replace(
    /(\"?(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|cookie|set-cookie|password|token)\"?\s*[:=]\s*)\"?[^\",}\]\s]+\"?/gi,
    '$1"[REDACTED]"',
  )
}
