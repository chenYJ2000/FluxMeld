/**
 * Provider icon resolver.
 *
 * Icons are build-time assets discovered automatically from
 * `src/renderer/src/assets/providers/*.svg`, so adding a provider only requires
 * dropping in an SVG (optionally referenced by `provider.ui.iconKey`). No
 * per-provider map needs to be edited.
 */

/// <reference types="vite/client" />

const svgModules = import.meta.glob('../assets/providers/*.svg', {
  eager: true,
  as: 'url',
}) as Record<string, string>

const iconByKey: Record<string, string> = {}
for (const [path, url] of Object.entries(svgModules)) {
  const key = path
    .split('/')
    .pop()
    ?.replace(/\.svg$/, '')
  if (key && !iconByKey[key]) {
    iconByKey[key] = url
  }
}

/** Aliases for providers that intentionally share another provider's icon. */
const ICON_ALIASES: Record<string, string> = {
  'qwen-ai': 'qwen',
  mapping: 'model-mapping',
}

export function getProviderIcon(iconKey?: string): string | undefined {
  if (!iconKey) return undefined
  return iconByKey[ICON_ALIASES[iconKey] ?? iconKey]
}

export function hasProviderIcon(iconKey?: string): boolean {
  return Boolean(getProviderIcon(iconKey))
}
