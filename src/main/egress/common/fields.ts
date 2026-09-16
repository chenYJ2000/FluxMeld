/**
 * Shared field-descriptor helpers.
 *
 * `meta.fields` is the single source of truth for a source's configuration:
 * the renderer builds the settings UI from it and the source-side logic reads
 * its defaults and constraints from the same declarations through
 * `resolveSourceSettings`, so a value is never defined twice.
 */

import type { EgressFieldDescriptor, EgressSourceModuleMeta } from '../types.ts'

/** Declared default for one field, or undefined when it has none. */
export function fieldDefault(meta: EgressSourceModuleMeta, key: string): unknown {
  return meta.fields.find((field) => field.key === key)?.defaultValue
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function fallbackNumber(field: EgressFieldDescriptor): number {
  return typeof field.defaultValue === 'number' && Number.isFinite(field.defaultValue)
    ? field.defaultValue
    : 0
}

function fallbackString(field: EgressFieldDescriptor): string {
  return typeof field.defaultValue === 'string' ? field.defaultValue : ''
}

function resolveFieldValue(field: EgressFieldDescriptor, raw: unknown): unknown {
  switch (field.type) {
    case 'number': {
      let value = toFiniteNumber(raw) ?? fallbackNumber(field)
      if (typeof field.min === 'number') value = Math.max(field.min, value)
      if (typeof field.max === 'number') value = Math.min(field.max, value)
      return value
    }
    case 'boolean':
      return typeof raw === 'boolean' ? raw : field.defaultValue === true
    case 'select': {
      const value = typeof raw === 'string' ? raw : ''
      if (value && (!field.options || field.options.some((option) => option.value === value))) {
        return value
      }
      return fallbackString(field)
    }
    case 'text':
    case 'textarea': {
      // A blank text value is treated as unset so the declared default applies.
      const value = typeof raw === 'string' ? raw.trim() : ''
      return value || fallbackString(field)
    }
    default: {
      // password | file: keep the raw string, including an intentionally empty one.
      return typeof raw === 'string' ? raw : fallbackString(field)
    }
  }
}

/**
 * Merge persisted settings with the defaults/constraints declared on
 * `meta.fields`. Returns an object containing every declared key with a
 * correctly typed value; unknown keys are dropped.
 */
export function resolveSourceSettings(
  meta: EgressSourceModuleMeta,
  provided: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const source = provided ?? {}
  const resolved: Record<string, unknown> = {}
  for (const field of meta.fields) {
    resolved[field.key] = resolveFieldValue(field, source[field.key])
  }
  return resolved
}
