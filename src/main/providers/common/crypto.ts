/**
 * Shared provider cryptography/ID helpers.
 *
 * Multi-provider shared methods live here so each provider module can reuse
 * them (or override locally). Currently consolidates identifiers used by many
 * provider adapters.
 */

import crypto from 'crypto'

/** RFC4122-style v4 identifier. Pass `false` to omit separators. */
export function uuid(separator: boolean = true): string {
  const id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
  return separator ? id : id.replace(/-/g, '')
}

/** MD5 hex digest. */
export function md5(input: string): string {
  return crypto.createHash('md5').update(input).digest('hex')
}

/** Current Unix time in seconds. */
export function unixTimestamp(): number {
  return Math.floor(Date.now() / 1000)
}
