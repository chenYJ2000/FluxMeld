/**
 * JSON config-file exit parsing.
 *
 * Accepted shapes:
 *   [ { "name": "hk-1", "protocol": "http", "host": "1.2.3.4", "port": 8080,
 *       "username": "u", "password": "p" }, ... ]
 * or an object wrapping the array under `proxies` / `list` / `nodes` / `exits`.
 *
 * Only `host` and `port` are required; `protocol` defaults to `http` and `name`
 * (节点名) is optional.
 */

import { readFileSync } from 'node:fs'
import type { EgressExit, EgressProtocol } from '../types.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function extractArray(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw
  if (isRecord(raw)) {
    for (const key of ['proxies', 'list', 'nodes', 'exits']) {
      const candidate = raw[key]
      if (Array.isArray(candidate)) return candidate
    }
  }
  return null
}

function normalizeProtocol(value: unknown): EgressProtocol {
  const protocol = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (protocol === 'socks5' || protocol === 'socks5h' || protocol === 'https') return protocol
  return 'http'
}

export interface ParsedExitResult {
  /** An entry array (top-level or under proxies/list/nodes/exits) was found. */
  found: boolean
  /** Number of entries inspected. */
  total: number
  /** Number of entries skipped as malformed. */
  skipped: number
  exits: EgressExit[]
}

/** Parse a decoded JSON value into exits, reporting malformed entries. */
export function parseExitEntriesDetailed(raw: unknown): ParsedExitResult {
  const items = extractArray(raw)
  if (!items) return { found: false, total: 0, skipped: 0, exits: [] }

  const exits: EgressExit[] = []
  const seen = new Set<string>()
  let skipped = 0

  items.forEach((item, index) => {
    if (!isRecord(item)) {
      skipped += 1
      return
    }

    const host = asString(item.host) ?? asString(item.ip)
    const port = typeof item.port === 'number' ? item.port : Number(item.port)
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      skipped += 1
      return
    }

    const name = asString(item.name)
    let id = name ?? `${host}:${port}`
    if (seen.has(id)) id = `${id}#${index}`
    seen.add(id)

    exits.push({
      id,
      name,
      protocol: normalizeProtocol(item.protocol),
      host,
      port,
      username: asString(item.username),
      password: asString(item.password),
    })
  })

  return { found: true, total: items.length, skipped, exits }
}

/** Parse a decoded JSON value into exits, skipping malformed entries. */
export function parseExitEntries(raw: unknown): EgressExit[] {
  return parseExitEntriesDetailed(raw).exits
}

/** Read and parse an exit list from a JSON file. */
export function readExitFile(filePath: string): EgressExit[] {
  const content = readFileSync(filePath, 'utf8')
  return parseExitEntries(JSON.parse(content))
}

/** Read and parse a JSON file, reporting malformed entries. */
export function readExitFileDetailed(filePath: string): ParsedExitResult {
  const content = readFileSync(filePath, 'utf8')
  return parseExitEntriesDetailed(JSON.parse(content))
}
