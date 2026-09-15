/**
 * Utils Module - Export all utility functions for tool calling
 */

export * from './tools'
// Unified tool parsing module (canonical)
export * from './toolParser/index'
// Legacy stream tool handler. The unified parser above is the source of truth
// for the conflicting flushToolCallBuffer / shouldBlockOutput exports, so only
// the legacy-only helpers are surfaced from the deprecated module.
export {
  type ToolCallState,
  createToolCallState,
  processStreamContent,
  createBaseChunk,
} from './streamToolHandler'
