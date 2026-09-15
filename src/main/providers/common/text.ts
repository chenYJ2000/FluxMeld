/**
 * Shared provider text helpers.
 *
 * Only genuinely shared logic lives here; provider-specific stripping
 * (citations, think tags) stays in the owning provider module.
 */

/**
 * Flatten an OpenAI-style message content value (string or text-part array)
 * into plain text. Text parts are joined with newlines.
 */
export function extractTextContent(
  content: string | Array<{ type?: string; text?: unknown }> | null | undefined,
): string {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  return content
    .filter((item) => item && item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text as string)
    .join('\n')
}
