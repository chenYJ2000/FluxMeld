/**
 * Copy text to the clipboard.
 *
 * `navigator.clipboard` only exists in secure contexts (HTTPS or localhost), so
 * the headless web UI served over plain HTTP on a LAN address has no Clipboard
 * API. Fall back to the legacy `execCommand('copy')` path in that case.
 *
 * Returns whether the copy succeeded so callers can surface feedback.
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Fall through to the legacy path (insecure context / denied permission).
    }
  }

  return legacyCopy(text)
}

function legacyCopy(text: string): boolean {
  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.top = '-9999px'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)

    const selection = document.getSelection()
    const previousRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null

    textarea.select()
    textarea.setSelectionRange(0, text.length)
    const ok = document.execCommand('copy')

    document.body.removeChild(textarea)

    if (selection && previousRange) {
      selection.removeAllRanges()
      selection.addRange(previousRange)
    }

    return ok
  } catch {
    return false
  }
}
